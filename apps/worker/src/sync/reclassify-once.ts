import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { RuleSnapshot } from '@epgs/matching-engine';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { reclassifyRecord } from './reclassify-record';

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
 * This file is only the CLI: the per-record logic - including how the level
 * is derived since issue #96 - lives in `./reclassify-record`, which has no
 * AppModule import so it can be unit-tested without a populated `.env`.
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
