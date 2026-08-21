import { PrismaClient, SyncJobStatus } from '@prisma/client';

/** Logical job name stored on every SyncJobLog row this job writes - lets ops query/filter if more sync jobs are added later. */
export const SYNC_JOB_NAME = 'pacs-ris-incremental-sync';

export interface ResolvedCursor {
  /** Inclusive lower bound to pass as FetchReportsParams.since for this run. */
  since: Date;
  /** cursorEnd value from the last SUCCEEDED/PARTIAL run, if any - stored for audit, not used for pagination directly (pagination cursor is per-page, see FetchReportsResult.nextCursor). */
  previousCursorEnd: string | null;
}

/**
 * Encodes a source-time-based resume point as the SyncJobLog.cursorEnd
 * string. Format: ISO-8601 instant. Kept intentionally simple (not the
 * PacsRisAdapter's opaque per-page pagination cursor, which only lives
 * for the duration of one run's paging loop) because this is the
 * cross-run resume point: "the source_updated_at high-water mark this
 * job has fully processed", which must be human-readable in ops queries
 * against sync_job_log and must not depend on adapter-internal cursor
 * encoding (which may change between adapter implementations).
 */
export function encodeCursor(date: Date): string {
  return date.toISOString();
}

export function decodeCursor(cursor: string): Date {
  const parsed = new Date(cursor);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`sync-cursor: invalid stored cursor "${cursor}"`);
  }
  return parsed;
}

/**
 * Resolves the `since` bound for the next sync run by:
 * 1. Finding the most recent SUCCEEDED or PARTIAL run's cursorEnd
 *    (RUNNING/FAILED runs are skipped - a FAILED run's window was NOT
 *    fully processed, so its cursorEnd must never become the next
 *    run's `since`, or unprocessed records would be silently skipped;
 *    see the "失败可重试且不会推进到丢数据的游标位置" acceptance
 *    criterion).
 * 2. Subtracting a configurable look-back window from that point, so a
 *    source outage/restart cannot cause records updated right at the
 *    edge of the last successful window to be missed - re-reading
 *    already-synced rows is safe because the whole pipeline is
 *    idempotent (MonitorRecord/MonitorMatch upserts on natural keys).
 * 3. Falling back to a full first-run window (`firstRunLookbackMs`
 *    before "now") when there is no prior successful run at all - this
 *    is the "首次全量窗口" test scenario.
 *
 * This function is read-only (a plain SELECT) - it does NOT create or
 * mutate any SyncJobLog row. The caller (sync-runner.ts) is responsible
 * for writing the RUNNING row for this attempt and later finalizing it.
 */
export async function resolveCursor(
  prisma: PrismaClient,
  now: Date,
  lookbackMs: number,
  firstRunLookbackMs: number,
): Promise<ResolvedCursor> {
  const lastGoodRun = await prisma.syncJobLog.findFirst({
    where: {
      jobName: SYNC_JOB_NAME,
      status: { in: [SyncJobStatus.SUCCEEDED, SyncJobStatus.PARTIAL] },
      cursorEnd: { not: null },
    },
    orderBy: { startedAt: 'desc' },
  });

  if (!lastGoodRun || !lastGoodRun.cursorEnd) {
    return {
      since: new Date(now.getTime() - firstRunLookbackMs),
      previousCursorEnd: null,
    };
  }

  const priorCursor = decodeCursor(lastGoodRun.cursorEnd);
  const since = new Date(priorCursor.getTime() - lookbackMs);
  return { since, previousCursorEnd: lastGoodRun.cursorEnd };
}
