/**
 * Stable DTOs for the push assistant (issue #70) - the right-corner "推送助理"
 * component that makes the otherwise-invisible worker push loop legible to
 * duty-room staff: is it alive, when does it push next, what did it just do,
 * and a "立即推送" button.
 *
 * Data-source contract (issue #70 §"状态与数据来源"):
 * - liveness / countdown come from the assistant_heartbeat row the worker
 *   writes every ~30s; the API judges 在线/失联 by its freshness (staleAfterMs).
 * - the activity feed rows come from assistant_event, written by the worker
 *   as it syncs / matches / pushes.
 * - the "刚完成" stats and "执行过程" timings come from the latest push_log /
 *   the latest PUSH_DONE event.
 * - the "预计推送预览" is computed the SAME way as MonitorService.summary +
 *   the #69 keyword aggregation, but ALWAYS unscoped (owner decision §4): the
 *   assistant shows what IT will push - the全院 window - not the viewer's
 *   department slice.
 *
 * PRIVACY (notification-design §7): no patient names, report bodies, or
 * webhook URLs ever appear in these DTOs - only counts, keywords, rule names,
 * durations, and timestamps.
 */

import type { NotificationPushStatusDto } from './notification';

/** Level enum mirrored from Prisma's MonitorLevel. */
export type PushAssistantLevelDto = 'RED' | 'YELLOW' | 'GREEN' | 'UNCLASSIFIED';

/**
 * The assistant's coarse operating state, derived by the API from heartbeat
 * freshness + the latest push_log:
 * - `ON_DUTY`  - heartbeat fresh, next push is in the future ("值班中")
 * - `JUST_DONE` - heartbeat fresh, a push finished within the look-back window ("刚完成")
 * - `OFFLINE`  - heartbeat stale (> staleAfterMs) ("失联")
 */
export type PushAssistantPhaseDto = 'ON_DUTY' | 'JUST_DONE' | 'OFFLINE';

/**
 * One activity-feed event type. Mirrors Prisma's AssistantEventType enum.
 *
 * NOTE there is no per-sync event: sync runs every few minutes and would
 * flood the short feed. "同步在跑" is surfaced as STATE on the status payload
 * (`todaySyncCount` / `lastSyncAt`), not as feed rows.
 */
export type AssistantEventTypeDto = 'KEYWORD_HIT' | 'PUSH_DONE';

/**
 * One activity-feed row (assistant_event). `summary` is a pre-rendered,
 * privacy-safe one-liner the web shows verbatim (e.g.
 * `红色命中「食管裂孔疝」新增 1 例 · 电子胃镜检查`); `detail` carries the same
 * facts structurally for any richer rendering.
 */
export interface AssistantEventDto {
  id: string;
  type: AssistantEventTypeDto;
  /** UTC instant the event occurred, ISO 8601. */
  occurredAt: string;
  /** Privacy-safe one-line summary, ready to display. */
  summary: string;
  /** Structured facts behind `summary` (shape depends on `type`). */
  detail: AssistantEventDetail;
}

/** Discriminated detail payloads for AssistantEventDto.detail. */
export type AssistantEventDetail =
  | { type: 'KEYWORD_HIT'; keyword: string; level: PushAssistantLevelDto; examItem: string | null }
  | {
      type: 'PUSH_DONE';
      ruleName: string;
      status: NotificationPushStatusDto;
      /** Distinct channels the run delivered to successfully. */
      groupCount: number;
      /** Wall-clock duration of the whole run, milliseconds. */
      elapsedMs: number;
      /** Per-phase timings the executor could measure (render + deliver). */
      stages: AssistantPushStageDto[];
    };

/** One phase of a push run with its wall-clock duration. */
export interface AssistantPushStageDto {
  name: 'sync' | 'match' | 'render' | 'deliver';
  elapsedMs: number;
}

/** Level counts for the "预计推送预览" / "刚完成" stats block. */
export interface PushAssistantCountsDto {
  red: number;
  yellow: number;
  green: number;
  unclassified: number;
  total: number;
}

/**
 * "预计推送预览" - what the next scheduled push would contain if it fired now,
 * for the window it will actually target (formatShanghaiDate(nextTriggerAt)).
 * ALWAYS全院 (unscoped). Null when there is no enabled rule / no next trigger.
 */
export interface PushAssistantPreviewDto {
  /** Shanghai YYYY-MM-DD the preview (and the upcoming push) targets. */
  windowDate: string;
  counts: PushAssistantCountsDto;
  /** TOP-5 red keyword hits, "词 ×次数" formatted, or "—". */
  redKeywords: string;
  /** TOP-3 yellow keyword hits, "词 ×次数" formatted, or "—". */
  yellowKeywords: string;
}

/**
 * "刚完成" hero - the most recent finished push run. Null when no push has
 * run yet (fresh install / DB reset).
 */
export interface PushAssistantLastRunDto {
  pushLogId: string;
  ruleName: string;
  windowDate: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  status: NotificationPushStatusDto | null;
  counts: PushAssistantCountsDto;
  redKeywords: string;
  yellowKeywords: string;
  /** Distinct channels delivered to successfully. */
  groupCount: number;
  /** Wall-clock duration of the run, milliseconds. */
  elapsedMs: number;
  /** UTC instant the run finished, ISO 8601; null while still in flight. */
  finishedAt: string | null;
  /** Per-phase timings (render + deliver); empty for pre-#70 rows. */
  stages: AssistantPushStageDto[];
}

/** An enabled push rule the "立即推送" button can trigger (reuses #61's run endpoint). */
export interface PushAssistantRunnableRuleDto {
  id: string;
  name: string;
}

/**
 * Aggregated assistant status - the single payload behind
 * `GET /api/notifications/assistant/status`, polled by the web every ~5s.
 */
export interface PushAssistantStatusDto {
  phase: PushAssistantPhaseDto;
  /** True iff the heartbeat is fresher than staleAfterMs. */
  online: boolean;
  /** UTC instant of the worker's last heartbeat write, ISO 8601; null if never. */
  lastSeenAt: string | null;
  /** Freshness threshold the API used to decide `online` (ASSISTANT_STALE_SECONDS × 1000). */
  staleAfterMs: number;
  /** UTC instant the next scheduled push fires, ISO 8601; null when no enabled rule. */
  nextTriggerAt: string | null;
  /** Whole days the current worker process has been running (process-level, resets on restart). */
  runningDays: number;
  /**
   * Reports synced from PACS so far today (Shanghai day): sum of successCount
   * across today's finished sync_job_log runs. Shown as panel state ("今日已
   * 同步 N 份"), replacing the per-sync feed rows.
   */
  todaySyncCount: number;
  /** UTC instant the most recent sync run finished, ISO 8601; null if none today. */
  lastSyncAt: string | null;
  /** Recent activity, newest first, capped at 4. */
  events: AssistantEventDto[];
  /** Preview of the upcoming push; null when no enabled rule. */
  preview: PushAssistantPreviewDto | null;
  /** The most recent finished push run; null when none has run. */
  lastRun: PushAssistantLastRunDto | null;
  /**
   * Enabled push rules the "立即推送" button triggers via
   * POST /api/notification-rules/:id/run (issue #61). Empty when no rule is
   * enabled - the button is then disabled, same as when OFFLINE.
   */
  runnableRules: PushAssistantRunnableRuleDto[];
}
