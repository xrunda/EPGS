import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { matchReport, MonitorLevel, RuleSnapshot } from '@epgs/matching-engine';
import { MonitorRecord, Prisma } from '@prisma/client';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { computeEffectiveLevel } from '../monitor/record-level';

/**
 * One-off ops script: re-runs matching for every EXISTING MonitorRecord
 * against the CURRENT enabled rule set, run as
 * `pnpm --filter worker run reclassify:once`.
 *
 * Why this exists: matching only happens inside the sync job's upsert
 * path (sync-runner.ts's upsertReport), gated by "is this report new or
 * changed since last sync". Records synced before a rule existed (or
 * before it was enabled) keep whatever currentLevel they got at sync
 * time forever - the rules UI explicitly documents this ("规则修改仅影响
 * 后续新数据，不自动重算历史数据"). This script is the deliberate,
 * manually-invoked exception: an operator who just seeded/edited rules
 * and wants the existing backlog reclassified against them runs this
 * once, rather than the system doing it automatically on every rule
 * change (which would be an expensive full-table rewrite triggered by a
 * routine CRUD operation).
 *
 * Same trust model as sync:once (see run-once.ts's doc comment): a CLI
 * script requiring shell access to the worker's runtime, not an HTTP
 * endpoint - no new attack surface, reuses AppModule's real DI wiring.
 *
 * ---------------------------------------------------------------------------
 * Issue #96: this script no longer assigns `current_level` itself.
 * ---------------------------------------------------------------------------
 * It used to write `matchResult.level` straight onto the record. That is the
 * KEYWORD engine's verdict, and since #87 and #88 it is no longer the record's
 * level: the semantic judge can drop a hit (#87) and the classifier can raise a
 * level (#88), and `monitor/record-level.ts` is the one place that combines
 * them. Writing the keyword verdict directly therefore undid both - an
 * AI-only RED went back to UNCLASSIFIED (the patient silently left the
 * workbench, and nothing would re-derive it, because the classifier queue is
 * `ai_resolved_at IS NULL` and would never revisit the record), and a filtered
 * hit came back as an effective one while its `semantic_filtered` flag stayed
 * true, so the level and its own evidence disagreed.
 *
 * The level is now built the way `record-level.ts` defines it, from two inputs:
 *
 *   1. the keyword hits THIS run re-derived against the current rule set,
 *      minus any hit the judge already filtered (matched by the schema's
 *      `uq_monitor_match_dedup` key). Re-deriving rather than reading
 *      `monitor_match` keeps the script's original meaning - a rule that has
 *      since been DISABLED stops counting, even though its old rows are still
 *      in the table as evidence and are never deleted;
 *   2. the record's `ai_attention_level`, which is passed through untouched.
 *
 * That is why this file calls `computeEffectiveLevel` rather than
 * `recomputeRecordLevels`: the two differ on exactly the disabled-rule case
 * above, and this script's job is to refresh the keyword side, not to
 * re-derive the level from rows a previous rule set left behind.
 */
async function main(): Promise<void> {
  const logger = new Logger('reclassify:once');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);

    const ruleRows = await prisma.monitorRule.findMany({ where: { isEnabled: true } });
    const rules: RuleSnapshot[] = ruleRows.map((r) => ({
      ruleId: r.id,
      ruleVersion: r.version,
      keyword: r.keyword,
      level: r.level,
      matchField: r.matchField,
      matchMode: r.matchMode,
      enabled: r.isEnabled,
    }));
    logger.log(`loaded ${rules.length} enabled rule(s)`);

    let processed = 0;
    let changed = 0;
    const pageSize = 200;
    let cursor: string | undefined;

    for (;;) {
      const records = await prisma.monitorRecord.findMany({
        take: pageSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (records.length === 0) {
        break;
      }

      for (const record of records) {
        const moved = await prisma.$transaction((tx) => reclassifyRecord(tx, record, rules));
        if (moved) {
          changed += 1;
        }
        processed += 1;
      }

      cursor = records[records.length - 1].id;
      logger.log(`processed=${processed} changed=${changed}`);
    }

    logger.log(`reclassify:once finished processed=${processed} changed=${changed}`);
  } finally {
    await app.close();
  }
}

/**
 * One hit's identity inside a record, mirroring the schema's
 * `uq_monitor_match_dedup (monitorRecordId, ruleId, matchedField, keyword,
 * reportVersion)`. The record id and the version are fixed for every hit of one
 * record, so these three parts are what tell two hits apart - and they are what
 * lets a re-derived hit be matched against the row the judge already ruled on.
 */
export function hitKey(ruleId: string, matchedField: string, keyword: string): string {
  return `${ruleId}\u0000${matchedField}\u0000${keyword}`;
}

/**
 * Re-match ONE record against `rules` and bring its `current_level` back in
 * line with `monitor/record-level.ts`. Returns whether the level actually
 * moved, so the caller can report a meaningful "changed" count.
 *
 * Takes a transaction client so the caller decides the transaction boundary:
 * the match rows, the level and the timestamps of a single record are written
 * together or not at all, exactly as the sync job does it.
 *
 * `now` is injectable so the timestamps a run writes are testable; production
 * callers omit it.
 */
export async function reclassifyRecord(
  tx: Prisma.TransactionClient,
  record: MonitorRecord,
  rules: RuleSnapshot[],
  now: Date = new Date(),
): Promise<boolean> {
  const matchResult = matchReport({
    reportId: record.reportId,
    reportVersion: record.reportVersion,
    describeText: record.reportContent,
    diagnoseText: record.diagnosis,
    rules,
  });

  if (matchResult.matchedRules.length > 0) {
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
          // Issue #87: same offsets sync-runner writes, so a reclassified
          // record's hits are judged from the same anchor a normally-synced
          // one would use.
          matchStart: occurrence.start,
          matchEnd: occurrence.end,
          reportVersion: record.reportVersion,
          matchedAt: now,
        });
      }
    }
    if (rows.length > 0) {
      // skipDuplicates: safe to re-run this script multiple times without
      // piling up duplicate MonitorMatch rows for a record whose matches
      // haven't changed since the last run. It is also what keeps a hit the
      // judge filtered from coming back: the row already occupies the dedup
      // key, so this insert cannot rewrite its `semanticFiltered` to false.
      await tx.monitorMatch.createMany({ data: rows, skipDuplicates: true });
    }
  }

  // What the judge has already ruled out, read AFTER the insert above so the
  // two agree on the same key set. Only `semanticFiltered = true` rows can
  // appear here; the column is one-sided by construction (see schema.prisma).
  const filtered = await tx.monitorMatch.findMany({
    where: { monitorRecordId: record.id, semanticFiltered: true },
    select: { ruleId: true, matchedField: true, keyword: true },
  });
  const filteredKeys = new Set(filtered.map((h) => hitKey(h.ruleId, h.matchedField, h.keyword)));

  const keywordLevels = matchResult.matchedRules
    .filter((m) => !filteredKeys.has(hitKey(m.ruleId, m.field, m.keyword)))
    .map((m) => m.level);

  const level = computeEffectiveLevel(keywordLevels, record.aiAttentionLevel);

  if (level === record.currentLevel) {
    return false;
  }

  await tx.monitorRecord.update({
    where: { id: record.id },
    data: {
      currentLevel: level as MonitorLevel,
      // Unchanged from before #96, and deliberately driven by the KEYWORD
      // engine's matches rather than by the effective set: these two record
      // when the keyword engine matched, which stays true no matter what
      // either AI task concluded (see record-level.ts).
      firstMatchedAt:
        matchResult.matchedRules.length > 0 ? (record.firstMatchedAt ?? now) : record.firstMatchedAt,
      lastMatchedAt: matchResult.matchedRules.length > 0 ? now : record.lastMatchedAt,
    },
  });
  return true;
}

// Only when run as the CLI entry point (`ts-node src/sync/reclassify-once.ts`),
// never when a test imports the helpers above.
if (require.main === module) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'fatal',
        message: `reclassify:once failed to run: ${err instanceof Error ? err.message : 'unknown error'}`,
      }),
    );
    process.exitCode = 1;
  });
}
