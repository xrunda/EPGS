import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { formatShanghaiDate, isCronDueAt } from '@epgs/notification-push';
import { AppModule } from '../app.module';
import { NotificationScheduler } from './notification-scheduler.service';
import { WorkerNotificationPushStore } from './worker-notification-push-store';

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
 * Without it, "now" is used and the run always executes for real (this is
 * the "scan right now, as an operator" case - identical risk to a real tick).
 *
 * SAFETY: because `NOTIFICATION_RUN_AT` makes the cron due-check see a
 * fabricated instant, a stray/stale value would otherwise make this look
 * exactly like a genuine scheduled tick - it writes a real `trigger:
 * SCHEDULED` push_log row (consuming that rule's once-per-day dedup slot)
 * and sends real WeCom messages, but with `startedAt` pinned to the
 * fabricated instant while delivery timestamps use the real clock. So
 * whenever `NOTIFICATION_RUN_AT` is set, this defaults to a DRY RUN: it only
 * reports which rules *would* fire, without calling the executor. Add
 * `CONFIRM_REAL_RUN=1` to actually execute and dispatch, e.g.
 *   NOTIFICATION_RUN_AT=2026-08-23T09:00:00+08:00 CONFIRM_REAL_RUN=1 \
 *     pnpm --filter worker run push:once
 *
 * Exit code: 0 when the scan (or dry run) completed (including already-pushed
 * dedups and zero due rules), 1 on an unexpected throw or when a run was
 * skipped because another was already in progress.
 */
async function main(): Promise<void> {
  const logger = new Logger('push:once');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const runAt = process.env.NOTIFICATION_RUN_AT;
    const now = runAt ? new Date(runAt) : undefined;
    if (runAt !== undefined && Number.isNaN(now?.getTime())) {
      logger.error(`NOTIFICATION_RUN_AT is not a valid ISO instant: "${runAt}"`);
      process.exitCode = 1;
      return;
    }

    const isFabricatedClock = now !== undefined;
    const confirmedRealRun = process.env.CONFIRM_REAL_RUN === '1';

    if (isFabricatedClock && !confirmedRealRun) {
      const store = app.get(WorkerNotificationPushStore);
      const today = formatShanghaiDate(now);
      const rules = await store.listEnabledRules();
      const due = rules.filter((rule) => isCronDueAt(rule.cron, now));

      logger.warn(
        `[DRY RUN] NOTIFICATION_RUN_AT=${runAt} simulates a fabricated clock - ` +
          'no rule was executed, no push_log written, no message sent.',
      );
      if (due.length === 0) {
        logger.log(`[DRY RUN] no enabled rule's cron matches this instant (window ${today}).`);
      } else {
        for (const rule of due) {
          logger.log(`[DRY RUN] rule "${rule.name}" (${rule.id}) would fire for window ${today}.`);
        }
      }
      logger.warn('Re-run with CONFIRM_REAL_RUN=1 to actually execute and send for real.');
      return;
    }

    const scheduler = app.get(NotificationScheduler);
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
