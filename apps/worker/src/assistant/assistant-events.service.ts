import { Injectable, Logger } from '@nestjs/common';
import { MonitorLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Structured payloads written into assistant_event.payload (issue #70). Kept
 * in sync with shared-types' AssistantEventDetail. PRIVACY: only counts,
 * keyword text, rule names, statuses and durations - never patient names,
 * report bodies, or webhook URLs (notification-design §7).
 */
export type AssistantEventInput =
  | { type: 'KEYWORD_HIT'; keyword: string; level: MonitorLevel; examItem: string | null }
  | {
      type: 'PUSH_DONE';
      ruleName: string;
      status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
      groupCount: number;
      elapsedMs: number;
      stages: { name: 'sync' | 'match' | 'render' | 'deliver'; elapsedMs: number }[];
    };

/**
 * Appends activity-feed rows the push assistant panel replays. The worker is
 * the only writer; the api reads them for GET /notifications/assistant/status.
 *
 * Failure policy: an event write must NEVER break the sync/push it describes -
 * every method swallows its own errors after logging. The feed is a
 * best-effort convenience, not a system of record (push_log / sync_job_log
 * remain authoritative).
 */
@Injectable()
export class AssistantEventsService {
  private readonly logger = new Logger(AssistantEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AssistantEventInput): Promise<void> {
    try {
      const { type, ...rest } = input;
      await this.prisma.assistantEvent.create({
        data: { type, payload: { type, ...rest } },
      });
    } catch (err) {
      this.logger.warn(
        `assistant event (${input.type}) write failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  /**
   * After a sync pass: one KEYWORD_HIT per distinct (keyword, level) whose
   * monitor_match rows were created inside `since..now`. Derived from
   * monitor_match (not the matcher internals) so this stays a thin read - and
   * honors the #69 "只统计启用规则" rule.
   *
   * NOTE we deliberately do NOT record a per-sync "已同步 N 份" event: sync
   * runs every few minutes and would flood the 4-row feed, burying the hits
   * and pushes that actually matter. "同步在跑" is surfaced as STATE instead -
   * the assistant panel's "今日已同步 N 份 · 最近 HH:MM" line (assembled by the
   * api from sync_job_log) and the "心跳 X 秒前" footer.
   */
  async recordSyncMatches(newReports: number, since: Date): Promise<void> {
    if (newReports === 0) return;
    try {
      const groups = await this.prisma.monitorMatch.groupBy({
        by: ['keyword', 'level'],
        where: { matchedAt: { gte: since }, rule: { isEnabled: true } },
        _count: { _all: true },
      });
      // Only surface RED/YELLOW hits - GREEN/UNCLASSIFIED are not what the
      // duty room watches, and flooding the 4-row feed with them buries the
      // signal.
      const notable = groups.filter(
        (g) => g.level === MonitorLevel.RED || g.level === MonitorLevel.YELLOW,
      );
      for (const g of notable) {
        const examItem = await this.firstExamItemForKeyword(g.keyword, since);
        await this.record({
          type: 'KEYWORD_HIT',
          keyword: g.keyword,
          level: g.level,
          examItem,
        });
      }
    } catch (err) {
      this.logger.warn(
        `assistant keyword-hit events skipped: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  private async firstExamItemForKeyword(keyword: string, since: Date): Promise<string | null> {
    const match = await this.prisma.monitorMatch.findFirst({
      where: { keyword, matchedAt: { gte: since }, rule: { isEnabled: true } },
      orderBy: { matchedAt: 'desc' },
      select: { record: { select: { examItem: true } } },
    });
    return match?.record?.examItem ?? null;
  }
}
