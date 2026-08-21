import { Logger } from '@nestjs/common';
import { PrismaClient, SyncJobStatus, Prisma } from '@prisma/client';
import { matchReport, RuleSnapshot } from '@epgs/matching-engine';
import { FetchReportsResult, PacsReportDto } from '@epgs/shared-types';
import { PacsRisAdapter } from '../pacs-adapter/pacs-ris-adapter.interface';
import { resolveCursor, encodeCursor, SYNC_JOB_NAME } from './sync-cursor';
import { withRetry } from './retry';
import { formatShanghai } from './time-format';

export interface SyncRunnerOptions {
  pageSize: number;
  lookbackMinutes: number;
  /** Used only when there is no prior successful run at all (first-ever sync). */
  firstRunLookbackMinutes: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncRunSummary {
  jobLogId: string;
  status: SyncJobStatus;
  readCount: number;
  successCount: number;
  failureCount: number;
  windowStart: Date;
  windowEnd: Date;
  cursorEnd: string | null;
}

/** Errors thrown by adapters that the sync runner should retry with backoff (see PacsHttpTransientError). Duck-typed on `.name` so this module doesn't need a hard dependency on http-pacs-ris-adapter.ts. */
function isRetryableBatchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'PacsHttpTransientError';
}

/**
 * Truncates and strips a raw error message down to something safe to
 * persist in SyncJobLog.errorSummary - per issue #6's "脱敏错误摘要" and
 * the schema's documented "禁止写入患者姓名、住院号等信息" constraint.
 *
 * This is a defense-in-depth measure, not the primary safety mechanism:
 * the primary mechanism is that callers of this function must only ever
 * pass non-patient-data strings (error class names, HTTP status/codes,
 * reportId/sourceRecordId, adapter error messages - all of which are
 * source identifiers, not clinical content per docs/data-dictionary.md).
 * As a second layer, this function also truncates length so a
 * pathological error message cannot bloat the log column.
 */
function summarize(message: string, maxLen = 500): string {
  const singleLine = message.replace(/\s+/g, ' ').trim();
  return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen)}...` : singleLine;
}

/**
 * Runs one incremental sync pass: resolve cursor -> page through the
 * adapter -> match + upsert each report -> finalize SyncJobLog.
 *
 * Idempotency: every MonitorRecord write is a Prisma upsert on the
 * natural key (sourceRecordId, reportId, reportVersion) - see
 * schema.prisma. MonitorMatch rows are only (re)created when the
 * report's content actually changed (detected via sourceUpdatedAt
 * moving forward for the same natural key) - see upsertReport below.
 * Running this function twice with the same source data must not
 * increase MonitorRecord/MonitorMatch/pending-report counts, satisfying
 * the "同一批次重复执行两次...数量不增加" acceptance criterion.
 *
 * Failure isolation: one report failing to parse/match/write increments
 * failureCount and is skipped (see the per-item try/catch below) without
 * aborting the run - the "单条坏数据不阻断整个批次" acceptance
 * criterion. A whole-page adapter failure (network/503/429) is retried
 * with exponential backoff (see retry.ts); if retries are exhausted, the
 * run is marked FAILED and its cursorEnd is left at the last
 * successfully-committed page boundary (never at the failed page), so
 * the next run resumes from before the loss point - the "不会推进到丢
 * 数据的游标位置" acceptance criterion.
 */
export async function runSync(
  prisma: PrismaClient,
  adapter: PacsRisAdapter,
  now: Date,
  options: SyncRunnerOptions,
  logger: Logger,
): Promise<SyncRunSummary> {
  const lookbackMs = options.lookbackMinutes * 60_000;
  const firstRunLookbackMs = options.firstRunLookbackMinutes * 60_000;
  const { since } = await resolveCursor(prisma, now, lookbackMs, firstRunLookbackMs);
  const windowEnd = now;

  const jobLog = await prisma.syncJobLog.create({
    data: {
      jobName: SYNC_JOB_NAME,
      status: SyncJobStatus.RUNNING,
      windowStart: since,
      windowEnd,
      cursorStart: encodeCursor(since),
      startedAt: now,
    },
  });

  logger.log(
    `sync run ${jobLog.id} started, window [${formatShanghai(since)}, ${formatShanghai(windowEnd)})`,
  );

  const rules = await loadEnabledRules(prisma);

  let readCount = 0;
  let successCount = 0;
  let failureCount = 0;
  /** High-water mark of sourceUpdatedAt among ALL rows successfully processed so far (across pages) - this becomes cursorEnd on success. Never advanced past a page that failed. */
  let committedCursor: Date = since;
  const errorSummaries: string[] = [];

  let pageCursor: string | undefined;
  let page = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      page += 1;
      const result: FetchReportsResult = await withRetry(
        () =>
          adapter.fetchReports({
            since,
            until: windowEnd,
            pageSize: options.pageSize,
            cursor: pageCursor,
          }),
        {
          maxRetries: options.maxRetries,
          baseDelayMs: options.retryBaseDelayMs,
          sleep: options.sleep,
          logger,
          isRetryable: isRetryableBatchError,
        },
      );

      logger.log(`sync run ${jobLog.id} page ${page}: fetched ${result.items.length} report(s)`);
      readCount += result.items.length;

      for (const item of result.items) {
        try {
          await upsertReportWithConcurrencyRetry(prisma, item, rules);
          successCount += 1;
          if (item.sourceUpdatedAt.getTime() > committedCursor.getTime()) {
            committedCursor = item.sourceUpdatedAt;
          }
        } catch (err) {
          failureCount += 1;
          // Only non-patient-data identifiers in the summary: reportId /
          // sourceRecordId are source keys, not clinical content or
          // patient names (see docs/data-dictionary.md sensitivity table).
          const message = err instanceof Error ? err.message : 'unknown error';
          errorSummaries.push(
            summarize(
              `reportId=${item.reportId} sourceRecordId=${item.sourceRecordId}: ${message}`,
            ),
          );
          logger.warn(
            `sync run ${jobLog.id}: failed to process reportId=${item.reportId} sourceRecordId=${item.sourceRecordId}: ${message}`,
          );
        }
      }

      if (!result.nextCursor) {
        break;
      }
      pageCursor = result.nextCursor;
    }

    const status = failureCount > 0 ? SyncJobStatus.PARTIAL : SyncJobStatus.SUCCEEDED;
    const cursorEnd = encodeCursor(committedCursor);

    await prisma.syncJobLog.update({
      where: { id: jobLog.id },
      data: {
        status,
        readCount,
        successCount,
        failureCount,
        cursorEnd,
        errorSummary:
          errorSummaries.length > 0
            ? summarize(errorSummaries.slice(0, 20).join(' | '), 4000)
            : null,
        finishedAt: new Date(),
      },
    });

    logger.log(
      `sync run ${jobLog.id} finished status=${status} read=${readCount} success=${successCount} failure=${failureCount}`,
    );

    return {
      jobLogId: jobLog.id,
      status,
      readCount,
      successCount,
      failureCount,
      windowStart: since,
      windowEnd,
      cursorEnd,
    };
  } catch (err) {
    // Whole-batch failure (adapter exhausted retries, or a non-retryable
    // adapter error like auth). Commit only up through the last fully
    // processed page's high-water mark - NEVER windowEnd - so the next
    // run's `since` (via resolveCursor) does not skip unprocessed data.
    const message = err instanceof Error ? err.message : 'unknown error';
    const cursorEnd =
      committedCursor.getTime() > since.getTime() ? encodeCursor(committedCursor) : null;

    await prisma.syncJobLog.update({
      where: { id: jobLog.id },
      data: {
        status: SyncJobStatus.FAILED,
        readCount,
        successCount,
        failureCount,
        cursorEnd,
        errorSummary: summarize(`batch failure at page ${page}: ${message}`, 4000),
        finishedAt: new Date(),
      },
    });

    logger.error(`sync run ${jobLog.id} FAILED at page ${page}: ${message}`);

    return {
      jobLogId: jobLog.id,
      status: SyncJobStatus.FAILED,
      readCount,
      successCount,
      failureCount,
      windowStart: since,
      windowEnd,
      cursorEnd,
    };
  }
}

async function loadEnabledRules(prisma: PrismaClient): Promise<RuleSnapshot[]> {
  const rows = await prisma.monitorRule.findMany({ where: { isEnabled: true } });
  return rows.map((r): RuleSnapshot => ({
    ruleId: r.id,
    ruleVersion: r.version,
    keyword: r.keyword,
    level: r.level,
    matchField: r.matchField,
    matchMode: r.matchMode,
    enabled: r.isEnabled,
  }));
}

/**
 * Wraps upsertReport with a single retry on a unique-constraint race
 * (Prisma error code P2002 on MonitorRecord's natural key or
 * MonitorMatch's dedup key). This addresses the "并发运行两个 worker 时
 * 不得生成重复记录" acceptance criterion: Prisma's upsert() compiles to
 * an atomic `INSERT ... ON CONFLICT DO UPDATE` for a single-unique-key
 * match on Postgres, so the DB itself never stores two rows for the same
 * natural key - but the `alreadyUpToDate` read (a separate SELECT before
 * the upsert, needed to decide whether to re-run matching) is not part
 * of that atomic operation. Two workers racing on the same brand-new
 * report can both see "no existing row", both attempt to create it, and
 * the loser's transaction fails with P2002. Retrying once re-reads the
 * now-existing row and correctly resolves to "already up to date, skip
 * matching" instead of surfacing a spurious per-report failure.
 */
async function upsertReportWithConcurrencyRetry(
  prisma: PrismaClient,
  item: PacsReportDto,
  rules: RuleSnapshot[],
): Promise<void> {
  try {
    await upsertReport(prisma, item, rules);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await upsertReport(prisma, item, rules);
      return;
    }
    throw err;
  }
}

/**
 * Upserts one PACS/RIS report into MonitorRecord, and - only if this is
 * a genuinely new report version for its natural key - (re)computes and
 * writes MonitorMatch rows.
 *
 * "Only if new/changed" is enforced by comparing the incoming
 * `sourceUpdatedAt` against the existing row's `sourceUpdatedAt` for the
 * SAME (sourceRecordId, reportId, reportVersion) tuple:
 * - No existing row -> new MonitorRecord + fresh match run (first sync
 *   of a brand-new report).
 * - Existing row with an EARLIER OR EQUAL sourceUpdatedAt -> this is a
 *   repeat delivery of data we've already fully processed (duplicate
 *   batch / re-read via the look-back window / at-least-once delivery).
 *   Skip re-matching entirely - this is what makes "same report version
 *   / repeated batch execution twice" produce zero additional
 *   MonitorMatch rows (Prisma upsert on MonitorRecord itself is also a
 *   no-op content-wise beyond touching updatedAt).
 * - Existing row with a STRICTLY LATER incoming sourceUpdatedAt -> the
 *   report content actually changed upstream without the source
 *   incrementing reportVersion (e.g. a corrected save under the same
 *   version) - re-run matching to pick up the change. This is a
 *   deliberate, documented choice: reportVersion is the source system's
 *   OWN versioning signal (see PacsReportDto doc) and this sync job does
 *   not invent its own version numbers; sourceUpdatedAt is a secondary,
 *   defensive check for "changed without a version bump", not a
 *   replacement for reportVersion.
 *
 * MonitorMatch idempotency itself is additionally guarded by the
 * schema's own unique constraint on (monitorRecordId, ruleId,
 * matchedField, keyword, reportVersion) - createMany with
 * skipDuplicates covers the case where this function is re-entered for
 * the same version concurrently by a second worker (see the
 * concurrent-workers test).
 */
async function upsertReport(
  prisma: PrismaClient,
  item: PacsReportDto,
  rules: RuleSnapshot[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const reportVersion = resolveReportVersion(item);

    const existing = await tx.monitorRecord.findUnique({
      where: {
        uq_monitor_record_source_version: {
          sourceRecordId: item.sourceRecordId,
          reportId: item.reportId,
          reportVersion,
        },
      },
    });

    const alreadyUpToDate =
      existing != null && existing.sourceUpdatedAt.getTime() >= item.sourceUpdatedAt.getTime();

    const record = await tx.monitorRecord.upsert({
      where: {
        uq_monitor_record_source_version: {
          sourceRecordId: item.sourceRecordId,
          reportId: item.reportId,
          reportVersion,
        },
      },
      create: {
        sourceRecordId: item.sourceRecordId,
        reportId: item.reportId,
        reportVersion,
        sourceUpdatedAt: item.sourceUpdatedAt,
        patientName: item.patientName || null,
        department: item.department,
        bedNo: item.bedNo,
        patientTypeCode: item.patientTypeCode,
        patientTypeName: item.patientTypeName,
        examItem: item.examItem,
        examTime: item.examTime,
        reportContent: item.reportContent,
        diagnosis: item.diagnosis,
        // currentLevel/firstMatchedAt/lastMatchedAt are set below, after
        // matching - defaults here are just the schema's UNCLASSIFIED/
        // null starting point for a brand-new row.
      },
      update: alreadyUpToDate
        ? {
            // No-op-ish touch: keep the snapshot fields fresh even when
            // skipping re-match (e.g. department renamed upstream with
            // no content change), but do not touch currentLevel/
            // firstMatchedAt/lastMatchedAt.
            patientName: item.patientName || null,
            department: item.department,
            bedNo: item.bedNo,
            patientTypeCode: item.patientTypeCode,
            patientTypeName: item.patientTypeName,
            examItem: item.examItem,
            examTime: item.examTime,
            reportContent: item.reportContent,
            diagnosis: item.diagnosis,
          }
        : {
            sourceUpdatedAt: item.sourceUpdatedAt,
            patientName: item.patientName || null,
            department: item.department,
            bedNo: item.bedNo,
            patientTypeCode: item.patientTypeCode,
            patientTypeName: item.patientTypeName,
            examItem: item.examItem,
            examTime: item.examTime,
            reportContent: item.reportContent,
            diagnosis: item.diagnosis,
          },
    });

    if (alreadyUpToDate) {
      return;
    }

    const matchResult = matchReport({
      reportId: item.reportId,
      reportVersion,
      describeText: item.reportContent,
      diagnoseText: item.diagnosis,
      rules,
    });

    if (matchResult.matchedRules.length > 0) {
      const matchedAt = new Date();
      const rows: Prisma.MonitorMatchCreateManyInput[] = [];
      for (const matched of matchResult.matchedRules) {
        for (const occurrence of matched.occurrences) {
          rows.push({
            monitorRecordId: record.id,
            ruleId: matched.ruleId,
            keyword: matched.keyword,
            level: matched.level,
            matchedField: matched.field,
            contextSnippet: occurrence.contextSnippet,
            reportVersion,
            matchedAt,
          });
        }
      }
      // skipDuplicates: belt-and-suspenders against the schema's own
      // unique constraint if two workers race on the same version (see
      // module doc comment above) - this createMany is otherwise safe
      // to call because `alreadyUpToDate` already gated us to "this is
      // either a brand-new row or a content change we haven't matched
      // yet in this transaction".
      if (rows.length > 0) {
        await tx.monitorMatch.createMany({ data: rows, skipDuplicates: true });
      }
    }

    await tx.monitorRecord.update({
      where: { id: record.id },
      data: {
        currentLevel: matchResult.level,
        firstMatchedAt:
          matchResult.matchedRules.length > 0
            ? (record.firstMatchedAt ?? matchedAtOrNow())
            : record.firstMatchedAt,
        lastMatchedAt: matchResult.matchedRules.length > 0 ? new Date() : record.lastMatchedAt,
      },
    });
  });
}

function matchedAtOrNow(): Date {
  return new Date();
}

/** MonitorRecord.reportVersion defaults to 1 - PacsReportDto has no explicit version field (see issue #2's DTO), so this sync job treats each distinct reportId as its own version-1 record. A future source-provided version signal, if #20 adds one, should replace this. */
function resolveReportVersion(_item: PacsReportDto): number {
  return 1;
}
