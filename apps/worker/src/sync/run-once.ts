import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { SyncService } from './sync.service';

/**
 * Manual sync trigger, run as `pnpm --filter worker run sync:once`.
 *
 * DESIGN CHOICE (documented per issue #6's "自行判断哪种更符合 NestJS
 * worker 的常见做法" instruction): a standalone CLI script that boots
 * the full Nest application context (`NestFactory.createApplicationContext`,
 * no HTTP listener) and calls the same `SyncService.runOnce()` the
 * scheduler uses, rather than adding a `POST /internal/sync/trigger` HTTP
 * endpoint. Reasons:
 *
 * - No new attack surface: an internal HTTP endpoint on the worker,
 *   even "unauthenticated because it's not internet-facing", is still a
 *   listening port that needs its own auth/network story to get right
 *   later; a CLI script has none of that - it only runs when an operator
 *   (or CI/ops tooling with shell access to the worker's environment)
 *   explicitly invokes it.
 * - Reuses `AppModule` as-is (env validation, DI wiring, the real
 *   `PACS_RIS_ADAPTER`/`PrismaService` providers) instead of duplicating
 *   config/bootstrap logic - so a manual run behaves identically to a
 *   scheduled tick, not a parallel code path that can drift out of sync.
 * - Matches how issue #4 already exposes an equivalent capability for
 *   apps/api (`prisma db seed` / `ts-node prisma/seed.ts` as an npm
 *   script, not an HTTP endpoint) - keeping the same "ops script, not a
 *   new endpoint" convention across the repo.
 *
 * Trade-off (documented, not hidden): this requires shell/deploy access
 * to the worker's runtime environment (env vars, network reachability to
 * Postgres and, in `http` PACS_ADAPTER_MODE, the #20 gateway) rather than
 * a simple authenticated HTTP call from a separate ops tool. If a
 * follow-up issue wants a remotely triggerable endpoint (e.g. for an
 * external scheduler/runbook), it should add proper authentication at
 * that time rather than reusing this script's trust model.
 *
 * Exit code: 0 on SUCCEEDED, 1 on FAILED or an unexpected throw, 2 on
 * PARTIAL (some reports failed but the run otherwise completed) - so CI/
 * ops tooling can distinguish "fully clean", "needs investigation but
 * made progress", and "hard failure, nothing progressed" at the process
 * level without parsing log lines.
 */
async function main(): Promise<void> {
  const logger = new Logger('sync:once');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const syncService = app.get(SyncService);
    const summary = await syncService.runOnce();

    if (!summary) {
      logger.warn('sync run skipped - another run was already in progress in this process');
      process.exitCode = 1;
      return;
    }

    logger.log(
      `sync:once finished status=${summary.status} read=${summary.readCount} success=${summary.successCount} failure=${summary.failureCount}`,
    );

    if (summary.status === 'FAILED') {
      process.exitCode = 1;
    } else if (summary.status === 'PARTIAL') {
      process.exitCode = 2;
    } else {
      process.exitCode = 0;
    }
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
      message: `sync:once failed to run: ${err instanceof Error ? err.message : 'unknown error'}`,
    }),
  );
  process.exitCode = 1;
});
