import { Injectable } from '@nestjs/common';
import { NotificationSummaryProvider, PushSummary, resolveShanghaiDayRange } from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';

const LEVEL_KEYS = {
  RED: 'red',
  YELLOW: 'yellow',
  GREEN: 'green',
  UNCLASSIFIED: 'unclassified',
} as const;

/**
 * The worker's summary provider (issue: push rules). Computes the same
 * "今日新报告" buckets as the api's MonitorService.summary with its own
 * GROUP BY over monitor_record - a scheduled push runs in this process and
 * must not depend on the api being up. The day window comes from the shared
 * package's pure resolveShanghaiDayRange, so the boundary math is identical
 * to the api's monitor-time.ts.
 *
 * `date` absent = count the full inventory (only ever reached by test-send,
 * which the worker never invokes; kept for interface completeness).
 */
@Injectable()
export class WorkerSummaryProvider implements NotificationSummaryProvider {
  constructor(private readonly prisma: PrismaService) {}

  async get(input: { date?: string; scope?: string[] }): Promise<PushSummary> {
    // The worker runs with global (unscoped) access - the scheduler is not an
    // end-user, so there is no department scope to honor. The `scope` field is
    // accepted for interface compatibility and ignored.
    const where =
      input.date !== undefined
        ? { examTime: resolveShanghaiDayRange(input.date) }
        : {};

    const groups = await this.prisma.monitorRecord.groupBy({
      by: ['currentLevel'],
      where,
      _count: { _all: true },
    });

    const result: PushSummary = { total: 0, red: 0, yellow: 0, green: 0, unclassified: 0 };
    for (const group of groups) {
      const key = LEVEL_KEYS[group.currentLevel];
      const count = group._count._all;
      result[key] = count;
      result.total += count;
    }
    return result;
  }
}
