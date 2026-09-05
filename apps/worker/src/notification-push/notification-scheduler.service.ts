import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  formatShanghaiDate,
  isCronDueAt,
  NotificationRuleExecutor,
  PUSH_CRON_TIMEZONE,
} from '@epgs/notification-push';
import { WorkerNotificationPushStore } from './worker-notification-push-store';
import { AssistantEventsService } from '../assistant/assistant-events.service';

/**
 * Scheduled push-rule tick (issue: push rules, user decision #1).
 *
 * Cadence: NOTIFICATION_TICK_SECONDS (env, default 60). Self-rescheduling
 * setTimeout - the next tick is scheduled only after the previous tick's
 * promise settles, so a slow run cannot overlap itself (same pattern and
 * rationale as SyncService, issue #6). Minute-granularity cron requires a
 * tick <= 60s so no fire minute is ever skipped, hence the 10-300s validation
 * in env.validation.ts.
 *
 * Each tick loads every enabled rule and executes those whose cron fires in
 * the current Asia/Shanghai minute, with the summary window = today (Shanghai)
 * via formatShanghaiDate. Idempotency is handled by the executor (SCHEDULED
 * runs at most once per (rule, windowDate) - app-layer guard + DB partial
 * unique index), so a second worker instance firing the same tick is harmless.
 *
 * LOGGING CONTRACT: logs name the RULE (config) and the aggregate status /
 * delivery count - never patient data, rendered bodies, or webhook URLs.
 *
 * `runDueRules(now)` is exported for the run-once tool and unit tests.
 */
@Injectable()
export class NotificationScheduler implements OnModuleInit {
  private readonly logger = new Logger(NotificationScheduler.name);
  private tickMs = 60_000;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly store: WorkerNotificationPushStore,
    private readonly executor: NotificationRuleExecutor,
    private readonly assistantEvents: AssistantEventsService,
  ) {}

  onModuleInit(): void {
    const seconds = this.config.get<number>('notificationTickSeconds', 60);
    this.tickMs = seconds * 1000;
    this.logger.log(`push scheduler tick every ${seconds}s (timezone ${PUSH_CRON_TIMEZONE})`);
    this.scheduleNext();
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runDueRules();
    } catch (err) {
      // Individual rule failures are recorded as FAILED deliveries by the
      // executor; this catch is only for truly unexpected errors (e.g. DB
      // connection lost outright) so the scheduler loop never dies.
      this.logger.error(
        `push tick threw unexpectedly: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Scans enabled rules and executes those due at `now` (defaults to the real
   * clock; tests / push:once inject a deterministic instant). Returns the
   * number of rules that EXECUTED (already-pushed dedups are not counted).
   * Guarded by `running` so a manual run during an in-flight tick is a no-op
   * rather than a double-run in this same process.
   */
  async runDueRules(now?: Date): Promise<number> {
    if (this.running) {
      this.logger.warn('push run requested while another run is already in progress in this process - skipping');
      return 0;
    }
    this.running = true;
    try {
      const current = now ?? new Date();
      const today = formatShanghaiDate(current);
      const rules = await this.store.listEnabledRules();

      let executed = 0;
      for (const rule of rules) {
        if (!isCronDueAt(rule.cron, current)) continue;

        this.logger.log(`push rule "${rule.name}" due for ${today}; executing`);
        const runStartedAt = Date.now();
        const result = await this.executor.execute({
          ruleId: rule.id,
          trigger: 'SCHEDULED',
          windowDate: today,
          now: current,
        });
        if (result.alreadyPushed) {
          this.logger.log(`push rule "${rule.name}" already pushed for ${today}; skipping`);
          continue;
        }
        executed += 1;
        // Issue #72: report link issuance next to the run outcome. Counts and
        // the (sanitized) failure reason only - never a token or patient data.
        const alertLinks = result.alertLinks ?? { issued: 0, error: null };
        this.logger.log(
          `push rule "${rule.name}" finished: status=${result.status} channels=${result.deliveries.length} alertLinks=${alertLinks.issued}`,
        );
        if (alertLinks.error) {
          this.logger.warn(
            `push rule "${rule.name}": alert links were NOT issued (template message still sent): ${alertLinks.error}`,
          );
        }

        // Push assistant feed (issue #70): a PUSH_DONE event the panel's
        // "刚完成" hero + "执行过程" bar read. The executor exposes render +
        // deliver as the phases it can measure; a full sync→match→render→send
        // breakdown is not available here (sync/match run elsewhere), so
        // `stages` carries only the whole-run wall clock as a single deliver
        // segment - the web renders whatever segments it gets.
        const elapsedMs = Date.now() - runStartedAt;
        await this.assistantEvents.record({
          type: 'PUSH_DONE',
          ruleName: rule.name,
          status: result.status ?? 'FAILED',
          groupCount: result.deliveries.filter((d) => d.status === 'SUCCESS').length,
          elapsedMs,
          stages: [{ name: 'deliver', elapsedMs }],
        });
      }
      return executed;
    } finally {
      this.running = false;
    }
  }

  /** Exposed for graceful shutdown / tests. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
}
