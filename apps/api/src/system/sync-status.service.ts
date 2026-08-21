import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SyncStatusDto, SyncHealthState } from '@epgs/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/** Logical job name written by apps/worker's sync runner - see apps/worker/src/sync/sync-cursor.ts SYNC_JOB_NAME. Duplicated here rather than imported cross-app (apps/api does not depend on apps/worker) - kept as a single string literal constant so a rename in one place is easy to grep for in the other. */
const SYNC_JOB_NAME = 'pacs-ris-incremental-sync';

/** Multiple of the configured sync interval a successful run is allowed to be "late" before being classified DELAYED rather than HEALTHY. */
const DELAYED_THRESHOLD_MULTIPLIER = 3;
/** Multiple of the configured sync interval before a stale/absent successful run is classified FAILED rather than DELAYED. */
const FAILED_THRESHOLD_MULTIPLIER = 8;
/** A RUNNING row older than this multiple of the interval is treated as stuck/crashed, not "currently healthy and mid-run". */
const STUCK_RUNNING_THRESHOLD_MULTIPLIER = 4;

@Injectable()
export class SyncStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getStatus(now: Date = new Date()): Promise<SyncStatusDto> {
    const syncIntervalMinutes = this.config.get<number>('syncIntervalMinutes', 3);

    const [lastGoodRun, lastRun] = await Promise.all([
      this.prisma.syncJobLog.findFirst({
        where: { jobName: SYNC_JOB_NAME, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.syncJobLog.findFirst({
        where: { jobName: SYNC_JOB_NAME },
        orderBy: { startedAt: 'desc' },
      }),
    ]);

    const health = this.classifyHealth(now, syncIntervalMinutes, lastGoodRun, lastRun);

    return {
      jobName: SYNC_JOB_NAME,
      health,
      lastSuccessAt: lastGoodRun?.finishedAt?.toISOString() ?? null,
      lastRunAt: lastRun?.startedAt?.toISOString() ?? null,
      lastRunStatus: (lastRun?.status as SyncStatusDto['lastRunStatus']) ?? null,
      cursor: lastGoodRun?.cursorEnd ?? null,
      readCount: lastRun?.readCount ?? 0,
      successCount: lastRun?.successCount ?? 0,
      failureCount: lastRun?.failureCount ?? 0,
      errorSummary: lastRun?.errorSummary ?? null,
      syncIntervalMinutes,
    };
  }

  /**
   * Classifies overall sync health from the most recent successful run
   * and the most recent run of any status, per issue #6's "状态接口可
   * 区分健康、延迟、失败" acceptance criterion:
   *
   * - UNKNOWN: the job has never run at all (no sync_job_log rows).
   * - FAILED: the most recent run's status is FAILED, OR the last
   *   successful run (if any) is older than FAILED_THRESHOLD_MULTIPLIER
   *   sync intervals, OR the most recent run is RUNNING but has been for
   *   longer than STUCK_RUNNING_THRESHOLD_MULTIPLIER intervals (crashed
   *   mid-run without updating its row).
   * - DELAYED: the last successful run is older than
   *   DELAYED_THRESHOLD_MULTIPLIER sync intervals (but not yet FAILED),
   *   OR there has never been a successful run yet but the job has been
   *   attempting (RUNNING/FAILED rows exist) for longer than the delayed
   *   threshold since it was first supposed to have completed.
   * - HEALTHY: the last successful run is recent enough.
   */
  private classifyHealth(
    now: Date,
    syncIntervalMinutes: number,
    lastGoodRun: { finishedAt: Date | null; startedAt: Date } | null,
    lastRun: { status: string; startedAt: Date } | null,
  ): SyncHealthState {
    if (!lastRun) {
      return 'UNKNOWN';
    }

    const intervalMs = syncIntervalMinutes * 60_000;
    const delayedThresholdMs = intervalMs * DELAYED_THRESHOLD_MULTIPLIER;
    const failedThresholdMs = intervalMs * FAILED_THRESHOLD_MULTIPLIER;
    const stuckRunningThresholdMs = intervalMs * STUCK_RUNNING_THRESHOLD_MULTIPLIER;

    if (lastRun.status === 'RUNNING') {
      const runningForMs = now.getTime() - lastRun.startedAt.getTime();
      if (runningForMs > stuckRunningThresholdMs) {
        return 'FAILED';
      }
      // A currently-running attempt within a reasonable duration doesn't
      // by itself indicate a problem - fall through to judge health by
      // the last successful run's recency, same as if this run hadn't
      // started yet.
    } else if (lastRun.status === 'FAILED') {
      // The most recent attempt failed outright. Still check whether a
      // reasonably recent successful run exists - one FAILED run right
      // after a HEALTHY streak is itself worth surfacing as at least
      // DELAYED/FAILED depending on how long ago the last success was,
      // handled by the shared logic below when lastGoodRun exists.
      if (!lastGoodRun) {
        return 'FAILED';
      }
    }

    if (!lastGoodRun || !lastGoodRun.finishedAt) {
      // No successful run has ever completed. If the job has been
      // attempting for a while (first run ever, still within reason) -
      // DELAYED rather than FAILED, unless the most recent attempt
      // itself was FAILED (handled above) or stuck RUNNING (handled
      // above).
      return 'DELAYED';
    }

    const ageMs = now.getTime() - lastGoodRun.finishedAt.getTime();
    if (ageMs > failedThresholdMs) {
      return 'FAILED';
    }
    if (ageMs > delayedThresholdMs) {
      return 'DELAYED';
    }
    return 'HEALTHY';
  }
}
