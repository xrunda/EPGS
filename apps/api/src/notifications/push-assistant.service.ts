import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MonitorLevel } from '@prisma/client';
import {
  formatKeywordHits,
  formatShanghaiDate,
  KeywordHit,
  resolveShanghaiDayRange,
} from '@epgs/notification-push';
import type {
  AssistantEventDto,
  AssistantEventDetail,
  AssistantPushStageDto,
  PushAssistantCountsDto,
  PushAssistantLastRunDto,
  PushAssistantPhaseDto,
  PushAssistantPreviewDto,
  PushAssistantStatusDto,
} from '@epgs/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorService } from '../monitor/monitor.service';

/** A push finished within this window counts as "刚完成" (JUST_DONE phase). */
const JUST_DONE_LOOKBACK_MS = 30 * 60 * 1000;
/** Activity feed rows shown in the panel. */
const FEED_LIMIT = 4;

/**
 * Assembles GET /api/notifications/assistant/status (issue #70) - the single
 * payload the right-corner 推送助理 polls every ~5s.
 *
 * Sources (issue #70 §"状态与数据来源"):
 *  - liveness / countdown  <- assistant_heartbeat (worker writes it)
 *  - activity feed          <- assistant_event (worker writes it)
 *  - "刚完成" stats + timings <- latest push_log + its PUSH_DONE event
 *  - "预计推送预览"          <- MonitorService.summary + #69 keyword aggregation,
 *                              ALWAYS UNSCOPED (owner decision §4): the assistant
 *                              shows what IT will push (全院), not the viewer's
 *                              department slice.
 *
 * PRIVACY (notification-design §7): only counts, keywords, rule names,
 * statuses, durations, timestamps - never patient data.
 */
@Injectable()
export class PushAssistantService {
  private readonly staleAfterMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly monitor: MonitorService,
    config: ConfigService,
  ) {
    this.staleAfterMs = config.get<number>('assistantStaleSeconds', 90) * 1000;
  }

  async getStatus(now: Date = new Date()): Promise<PushAssistantStatusDto> {
    const [heartbeat, events, lastRun, runnableRules, syncState] = await Promise.all([
      this.prisma.assistantHeartbeat.findUnique({ where: { id: 'singleton' } }),
      this.loadEvents(),
      this.loadLastRun(),
      this.prisma.notificationRule.findMany({
        where: { isEnabled: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.loadSyncState(now),
    ]);

    const lastSeenAt = heartbeat?.lastSeenAt ?? null;
    const online = lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() <= this.staleAfterMs;
    const nextTriggerAt = heartbeat?.nextTriggerAt ?? null;

    const phase = this.derivePhase(online, lastRun, now);
    const preview = online && nextTriggerAt ? await this.buildPreview(nextTriggerAt) : null;
    const runningDays =
      heartbeat?.runningSince != null
        ? Math.max(
            0,
            Math.floor((now.getTime() - heartbeat.runningSince.getTime()) / (24 * 60 * 60 * 1000)),
          )
        : 0;

    return {
      phase,
      online,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
      staleAfterMs: this.staleAfterMs,
      nextTriggerAt: nextTriggerAt?.toISOString() ?? null,
      runningDays,
      todaySyncCount: syncState.todaySyncCount,
      lastSyncAt: syncState.lastSyncAt,
      events,
      preview,
      lastRun,
      runnableRules,
    };
  }

  /**
   * "同步在跑" as STATE, not feed rows: sum of successCount across today's
   * (Shanghai-day) finished sync_job_log runs + the latest finish instant.
   * A per-sync event would flood the 4-row activity feed - this line lives in
   * the panel hero instead.
   */
  private async loadSyncState(
    now: Date,
  ): Promise<{ todaySyncCount: number; lastSyncAt: string | null }> {
    const dayStart = resolveShanghaiDayRange(formatShanghaiDate(now)).gte;
    const rows = await this.prisma.syncJobLog.findMany({
      where: { finishedAt: { gte: dayStart }, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
      select: { successCount: true, finishedAt: true },
      orderBy: { finishedAt: 'desc' },
    });
    const todaySyncCount = rows.reduce((sum, r) => sum + r.successCount, 0);
    const lastSyncAt = rows[0]?.finishedAt?.toISOString() ?? null;
    return { todaySyncCount, lastSyncAt };
  }

  private derivePhase(
    online: boolean,
    lastRun: PushAssistantLastRunDto | null,
    now: Date,
  ): PushAssistantPhaseDto {
    if (!online) return 'OFFLINE';
    if (
      lastRun?.finishedAt != null &&
      now.getTime() - new Date(lastRun.finishedAt).getTime() <= JUST_DONE_LOOKBACK_MS
    ) {
      return 'JUST_DONE';
    }
    return 'ON_DUTY';
  }

  private async loadEvents(): Promise<AssistantEventDto[]> {
    const rows = await this.prisma.assistantEvent.findMany({
      orderBy: { occurredAt: 'desc' },
      take: FEED_LIMIT,
    });
    return rows.map((row) => {
      const detail = row.payload as unknown as AssistantEventDetail;
      return {
        id: row.id,
        type: row.type,
        occurredAt: row.occurredAt.toISOString(),
        summary: summarizeEvent(detail),
        detail,
      };
    });
  }

  private async loadLastRun(): Promise<PushAssistantLastRunDto | null> {
    const log = await this.prisma.pushLog.findFirst({
      where: { finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      include: {
        rule: { include: { template: true } },
        deliveries: true,
      },
    });
    if (!log) return null;

    // Counts + keyword hits for the exact window this run pushed, UNSCOPED so
    // they equal what the worker actually sent (owner decision §4).
    const { counts, redKeywords, yellowKeywords } = await this.windowFacts(log.windowDate);

    const pushDoneEvent = await this.prisma.assistantEvent.findFirst({
      where: { type: 'PUSH_DONE' },
      orderBy: { occurredAt: 'desc' },
    });
    const eventDetail = pushDoneEvent?.payload as
      { elapsedMs?: number; stages?: AssistantPushStageDto[]; ruleName?: string } | undefined;
    const matchesThisRun = eventDetail?.ruleName === log.rule?.name;

    const succeededChannels = log.deliveries.filter((d) => d.status === 'SUCCESS').length;
    const elapsedMs =
      log.finishedAt != null ? log.finishedAt.getTime() - log.startedAt.getTime() : 0;

    return {
      pushLogId: log.id,
      ruleName: log.rule?.name ?? '',
      windowDate: log.windowDate,
      trigger: log.trigger,
      status: log.status,
      counts,
      redKeywords,
      yellowKeywords,
      groupCount: succeededChannels,
      elapsedMs:
        matchesThisRun && eventDetail?.elapsedMs != null ? eventDetail.elapsedMs : elapsedMs,
      finishedAt: log.finishedAt?.toISOString() ?? null,
      stages: matchesThisRun && eventDetail?.stages ? eventDetail.stages : [],
    };
  }

  private async buildPreview(nextTriggerAt: Date): Promise<PushAssistantPreviewDto> {
    // The window the UPCOMING push will target - not "today" (owner decision
    // §4): at 23:30 the next fire is tomorrow 18:00, so preview tomorrow.
    const windowDate = formatShanghaiDate(nextTriggerAt);
    const { counts, redKeywords, yellowKeywords } = await this.windowFacts(windowDate);
    return { windowDate, counts, redKeywords, yellowKeywords };
  }

  /**
   * Level counts + TOP-N keyword-hit strings for one Shanghai day, UNSCOPED.
   * Mirrors the worker's WorkerSummaryProvider exactly (same GROUP BY over
   * monitor_record + the #69 monitor_match aggregation, enabled rules only),
   * so preview == what the scheduled push renders.
   */
  private async windowFacts(windowDate: string): Promise<{
    counts: PushAssistantCountsDto;
    redKeywords: string;
    yellowKeywords: string;
  }> {
    const summary = await this.monitor.summary(
      { examDateFrom: windowDate, examDateTo: windowDate },
      // No scope: the assistant's preview is全院, matching the worker's push.
      {},
    );
    const range = resolveShanghaiDayRange(windowDate);
    const keywordHits = await this.aggregateKeywordHits(range);
    return {
      counts: {
        red: summary.red,
        yellow: summary.yellow,
        green: summary.green,
        unclassified: summary.unclassified,
        total: summary.total,
      },
      redKeywords: formatKeywordHits(keywordHits, 'RED', 5),
      yellowKeywords: formatKeywordHits(keywordHits, 'YELLOW', 3),
    };
  }

  private async aggregateKeywordHits(range: { gte: Date; lt: Date }): Promise<KeywordHit[]> {
    const rows = await this.prisma.monitorMatch.groupBy({
      by: ['keyword', 'level'],
      // Issue #87: effective hits only - the preview must show the same
      // keyword counts the push will render, and both exclude hits the AI
      // semantic judge filtered.
      where: { record: { examTime: range }, rule: { isEnabled: true }, semanticFiltered: false },
      _count: { _all: true },
    });
    return rows.map((row) => ({ keyword: row.keyword, level: row.level, count: row._count._all }));
  }
}

const LEVEL_LABEL: Record<MonitorLevel, string> = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
  UNCLASSIFIED: '未分级',
};

/**
 * Renders one activity-feed row's one-liner (privacy-safe: counts, keyword,
 * rule name, status, duration only). The web can show `summary` verbatim.
 */
function summarizeEvent(detail: AssistantEventDetail): string {
  switch (detail.type) {
    case 'KEYWORD_HIT': {
      const where = detail.examItem ? ` · ${detail.examItem}` : '';
      return `${LEVEL_LABEL[detail.level as MonitorLevel] ?? detail.level}命中「${detail.keyword}」新增 1 例${where}`;
    }
    case 'PUSH_DONE': {
      const seconds = (detail.elapsedMs / 1000).toFixed(1);
      const statusText =
        detail.status === 'SUCCESS'
          ? '推送成功'
          : detail.status === 'PARTIAL'
            ? '部分成功'
            : '推送失败';
      return `${detail.ruleName} ${statusText} · ${detail.groupCount} 群 · ${seconds}s`;
    }
    default:
      return '';
  }
}
