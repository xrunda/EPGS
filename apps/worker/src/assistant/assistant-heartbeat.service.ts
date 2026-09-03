import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { earliestNextTriggerAt, PUSH_CRON_TIMEZONE } from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';

const HEARTBEAT_ID = 'singleton';
/** Run the assistant_event retention sweep once every N heartbeat ticks. */
const SWEEP_EVERY_TICKS = 20;

/**
 * The push assistant's DB heartbeat loop (issue #70).
 *
 * The worker sits behind the 网闸: the browser can only reach the api, and the
 * api cannot probe the worker process (its :3001 /health is not exposed). So
 * liveness is published through the database - this loop rewrites the single
 * assistant_heartbeat row every ASSISTANT_HEARTBEAT_SECONDS (default 30) with:
 *   - lastSeenAt    = now  (the api flags 失联 when this is older than its
 *                     own ASSISTANT_STALE_SECONDS, ~3× this cadence)
 *   - nextTriggerAt = earliest next fire across all ENABLED push rules,
 *                     recomputed each tick (Asia/Shanghai); null when no
 *                     rule is enabled -> the panel shows "未排程"
 *
 * This is a DEDICATED timer, deliberately independent of NotificationScheduler
 * (whose tick is NOTIFICATION_TICK_SECONDS, default 60): the assistant's
 * "距下次推送" countdown wants a tighter, fixed cadence than the push tick and
 * must keep beating even while a slow push run is in flight.
 *
 * Same self-rescheduling setTimeout pattern as SyncService / NotificationScheduler
 * so a slow tick cannot overlap itself. runningSince is written once at startup
 * (process-level "连续运行天数" - owner decision §5, no cross-restart total).
 */
@Injectable()
export class AssistantHeartbeatService implements OnModuleInit {
  private readonly logger = new Logger(AssistantHeartbeatService.name);
  private intervalMs = 30_000;
  private retentionDays = 7;
  private timer?: NodeJS.Timeout;
  private tickCount = 0;
  private readonly runningSince = new Date();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const seconds = this.config.get<number>('assistantHeartbeatSeconds', 30);
    this.intervalMs = seconds * 1000;
    this.retentionDays = this.config.get<number>('assistantEventRetentionDays', 7);
    this.logger.log(
      `assistant heartbeat every ${seconds}s (timezone ${PUSH_CRON_TIMEZONE}); event retention ${this.retentionDays}d`,
    );
    // Write once immediately so the assistant is 在线 the moment the worker is
    // up, not one interval later. Guarded like every other tick: a DB blip at
    // startup must not crash the worker boot - the next tick will retry.
    try {
      await this.beat();
    } catch (err) {
      this.logger.warn(
        `initial assistant heartbeat failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.beat();
      this.tickCount += 1;
      if (this.tickCount % SWEEP_EVERY_TICKS === 0) {
        await this.sweepOldEvents();
      }
    } catch (err) {
      // The heartbeat is best-effort: a DB blip must not kill the loop, or the
      // assistant would stay 失联 forever after one transient error.
      this.logger.warn(
        `assistant heartbeat tick failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.scheduleNext();
    }
  }

  /** Upserts lastSeenAt + nextTriggerAt. Exported-ish via `stop()` for tests. */
  private async beat(): Promise<void> {
    const now = new Date();
    const nextTriggerAt = await this.computeNextTriggerAt(now);
    await this.prisma.assistantHeartbeat.upsert({
      where: { id: HEARTBEAT_ID },
      create: {
        id: HEARTBEAT_ID,
        lastSeenAt: now,
        nextTriggerAt,
        runningSince: this.runningSince,
      },
      // runningSince is written on EVERY beat, not just create: it is this
      // process's start time, and a worker restart must reset the panel's
      // "连续运行 N 天" (owner decision §5 - process-level, no cross-restart
      // total). The value is fixed for the life of the process.
      update: { lastSeenAt: now, nextTriggerAt, runningSince: this.runningSince },
    });
  }

  private async computeNextTriggerAt(from: Date): Promise<Date | null> {
    const rules = await this.prisma.notificationRule.findMany({
      where: { isEnabled: true },
      select: { cron: true },
    });
    if (rules.length === 0) return null;
    try {
      return earliestNextTriggerAt(
        rules.map((r) => r.cron),
        from,
      );
    } catch (err) {
      // A malformed cron on one rule shouldn't blank the whole countdown.
      this.logger.warn(
        `next-trigger computation failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return null;
    }
  }

  private async sweepOldEvents(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.assistantEvent.deleteMany({
      where: { occurredAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`swept ${count} assistant_event row(s) older than ${this.retentionDays}d`);
    }
  }

  /** Exposed for graceful shutdown / tests. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
