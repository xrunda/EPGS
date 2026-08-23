import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { NotificationScheduler } from './notification-scheduler.service';

/**
 * Manual push-rule scan, run as `pnpm --filter worker run push:once`.
 *
 * Boots the full Nest application context (no HTTP listener) and calls the
 * same `NotificationScheduler.runDueRules()` the scheduler's tick uses, so a
 * manual scan behaves identically to a scheduled tick - same store, executor,
 * idempotency, and logging. Mirrors sync:once's design: a standalone ops
 * script rather than an HTTP endpoint (no new attack surface), reusing
 * AppModule as-is (see src/sync/run-once.ts's doc comment for the full
 * rationale).
 *
 * `NOTIFICATION_RUN_AT` (ISO 8601, any timezone) overrides the clock used for
 * the cron due-check AND the summary window - the deterministic path for
 * testing that a rule fires at its configured time, e.g.
 *   NOTIFICATION_RUN_AT=2026-08-23T09:00:00+08:00 pnpm --filter worker run push:once
 * Without it, "now" is used.
 *
 * Exit code: 0 when the scan completed (including already-pushed dedups and
 * zero due rules), 1 on an unexpected throw or when a run was skipped because
 * another was already in progress.
 */
async function main(): Promise<void> {
  const logger = new Logger('push:once');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const scheduler = app.get(NotificationScheduler);

    const runAt = process.env.NOTIFICATION_RUN_AT;
    const now = runAt ? new Date(runAt) : undefined;
    if (runAt !== undefined && Number.isNaN(now?.getTime())) {
      logger.error(`NOTIFICATION_RUN_AT is not a valid ISO instant: "${runAt}"`);
      process.exitCode = 1;
      return;
    }

    const executed = await scheduler.runDueRules(now);
    logger.log(`push:once finished executed=${executed}`);
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
      message: `push:once failed to run: ${err instanceof Error ? err.message : 'unknown error'}`,
    }),
  );
  process.exitCode = 1;
});
