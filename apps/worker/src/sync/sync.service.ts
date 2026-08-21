import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PACS_RIS_ADAPTER, PacsRisAdapter } from '../pacs-adapter/pacs-ris-adapter.interface';
import { PrismaService } from '../prisma/prisma.service';
import { runSync, SyncRunSummary } from './sync-runner';
import { SystemClock } from './clock';

/**
 * Scheduled incremental PACS/RIS sync job (issue #6). Replaces the
 * issue #1 placeholder that only logged "sync tick" - this is now the
 * single implementation (no parallel placeholder left behind).
 *
 * Cadence: SYNC_INTERVAL_MINUTES (env, default 3, validated to the
 * issue's required 1-5 minute range - see env.validation.ts). Scheduled
 * with a self-rescheduling `setTimeout` (delay measured from the END of
 * the previous run, not a fixed `@Interval`/`@Cron` period) so a slow
 * run (e.g. large backlog, retries) cannot overlap with itself - the
 * next tick is scheduled only after the current run's promise settles,
 * which also gives a natural, simple form of "only one sync run per
 * process at a time" without extra locking. `@nestjs/schedule`'s
 * `ScheduleModule.forRoot()` is still imported in SyncModule (issue #1)
 * for consistency with the rest of the app's scheduling story, but this
 * service does not use its decorators directly for the reason above.
 * Cross-process concurrency (two worker instances) is handled at the
 * data layer instead - see sync-runner.ts's upsert idempotency/race-
 * retry doc comment.
 *
 * `runOnce()` is exported for reuse (manual trigger via
 * `pnpm --filter worker run sync:once`, see run-once.ts) and for the
 * sync.service.spec.ts unit tests.
 */
@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);
  private intervalMs = 0;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(PACS_RIS_ADAPTER) private readonly adapter: PacsRisAdapter,
    private readonly clock: SystemClock,
  ) {}

  onModuleInit(): void {
    const minutes = this.config.get<number>('syncIntervalMinutes', 3);
    this.intervalMs = minutes * 60_000;
    this.logger.log(`sync job scheduled every ${minutes} minute(s)`);
    this.scheduleNext();
  }

  /**
   * Uses a self-rescheduling setTimeout (via NestJS's SchedulerRegistry-
   * free `Interval` decorator would fire on a fixed period regardless of
   * run duration - not what we want here, see class doc). Implemented
   * directly rather than via `@Interval()` for that reason, while still
   * depending on `@nestjs/schedule` being imported in SyncModule so this
   * stays consistent with the rest of the app's scheduling story and any
   * future jobs that DO want fixed-period `@Interval`/`@Cron` semantics.
   */
  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      // runSync() already catches and records adapter/report-level
      // failures into SyncJobLog; this catch is only for truly
      // unexpected errors (e.g. DB connection lost outright) so the
      // scheduler loop itself never dies.
      this.logger.error(
        `sync tick threw unexpectedly: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.scheduleNext();
    }
  }

  /** Runs one sync pass immediately. Safe to call concurrently with the scheduled loop - guarded by `running` so a manual trigger during an in-flight scheduled run is a no-op rather than a double-run within this same process. */
  async runOnce(): Promise<SyncRunSummary | null> {
    if (this.running) {
      this.logger.warn(
        'sync run requested while another run is already in progress in this process - skipping',
      );
      return null;
    }
    this.running = true;
    try {
      return await runSync(
        this.prisma,
        this.adapter,
        this.clock.now(),
        {
          pageSize: this.config.get<number>('syncPageSize', 200),
          lookbackMinutes: this.config.get<number>('syncLookbackMinutes', 10),
          firstRunLookbackMinutes: this.config.get<number>('syncFirstRunLookbackMinutes', 1440),
          maxRetries: this.config.get<number>('syncMaxRetries', 5),
          retryBaseDelayMs: this.config.get<number>('syncRetryBaseDelayMs', 1000),
        },
        this.logger,
      );
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
