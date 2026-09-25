import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { matchReport, RuleSnapshot } from '@epgs/matching-engine';
import { Prisma } from '@prisma/client';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

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
        const matchResult = matchReport({
          reportId: record.reportId,
          reportVersion: record.reportVersion,
          describeText: record.reportContent,
          diagnoseText: record.diagnosis,
          rules,
        });

        await prisma.$transaction(async (tx) => {
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
                  // Issue #87: same offsets sync-runner writes, so a
                  // reclassified record's hits are judged from the same
                  // anchor a normally-synced one would use.
                  matchStart: occurrence.start,
                  matchEnd: occurrence.end,
                  reportVersion: record.reportVersion,
                  matchedAt,
                });
              }
            }
            if (rows.length > 0) {
              // skipDuplicates: safe to re-run this script multiple times
              // without piling up duplicate MonitorMatch rows for a
              // record whose matches haven't changed since the last run.
              await tx.monitorMatch.createMany({ data: rows, skipDuplicates: true });
            }
          }

          if (matchResult.level !== record.currentLevel) {
            await tx.monitorRecord.update({
              where: { id: record.id },
              data: {
                currentLevel: matchResult.level,
                firstMatchedAt:
                  matchResult.matchedRules.length > 0
                    ? (record.firstMatchedAt ?? new Date())
                    : record.firstMatchedAt,
                lastMatchedAt:
                  matchResult.matchedRules.length > 0 ? new Date() : record.lastMatchedAt,
              },
            });
            changed += 1;
          }
        });

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

function matchedAt(): Date {
  return new Date();
}

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
