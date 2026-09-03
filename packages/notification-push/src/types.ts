/**
 * Framework- and DB-agnostic types for the shared notification push pipeline
 * (issue: push rules). These are STRUCTURAL on purpose: the package must not
 * import `@prisma/client` (both apps own their own generated client), so every
 * row the store reads/writes is described here as a plain shape. The api and
 * worker adapters translate their Prisma rows into these shapes.
 */

/** Message shape pushed to WeCom. Mirrors Prisma's NotificationMsgType enum. */
export type PushMsgType = 'TEXT' | 'NEWS';

/** Why a run was created. Mirrors Prisma's NotificationPushTrigger enum. */
export type PushTrigger = 'SCHEDULED' | 'MANUAL';

/** Aggregate run status across all of a rule's channels. Mirrors NotificationPushStatus. */
export type PushStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

/** Per-channel delivery outcome. Mirrors NotificationPushDeliveryStatus. */
export type PushDeliveryStatus = 'SUCCESS' | 'FAILED';

/** Level enum mirrored from Prisma's MonitorLevel (the package is @prisma/client-free). */
export type PushLevel = 'RED' | 'YELLOW' | 'GREEN' | 'UNCLASSIFIED';

/**
 * One "命中次数" aggregation row backing the {{redKeywords}}/{{yellowKeywords}}
 * template variables (issue #69): how many monitor_match rows carried a given
 * keyword at a given level within the day window. Counts MATCHES, not records
 * - a record hitting two keywords contributes one count to each. `level` is
 * the snapshot stored on the match row at match time.
 */
export interface KeywordHit {
  keyword: string;
  level: PushLevel;
  count: number;
}

/**
 * Level counts backing the {{...}} template variables. Shape mirrors what
 * GET /api/monitor/summary returns so both adapters can map 1:1 (the api
 * adapts MonitorService.summary directly; the worker computes the same
 * buckets with its own GROUP BY over monitor_record). `keywordHits` is the
 * raw per-keyword aggregation (issue #69) - render.ts turns it into the
 * TOP-N formatted strings for the template.
 */
export interface PushSummary {
  total: number;
  red: number;
  yellow: number;
  green: number;
  unclassified: number;
  keywordHits: KeywordHit[];
}

/** A channel row as loaded by the store. */
export interface PushChannel {
  id: string;
  name: string;
  /** AES-256-GCM ciphertext of the WeCom webhook URL (see schema.prisma). */
  webhookUrlCiphertext: string;
  isEnabled: boolean;
}

/** A template row as loaded by the store. */
export interface PushTemplate {
  id: string;
  msgType: PushMsgType;
  /** Present only when msgType = NEWS; null otherwise. */
  titleTemplate: string | null;
  contentTemplate: string;
  coverImageUrl: string | null;
  linkUrl: string | null;
  isEnabled: boolean;
}

/** One channel binding inside a rule, with its channel row preloaded. */
export interface PushRuleChannel {
  id: string;
  channelId: string;
  channel: PushChannel;
}

/** A rule row as loaded by the store, with template + channels preloaded. */
export interface PushRule {
  id: string;
  name: string;
  /** 5-field cron expression (minute-hour-day-month-dow), Asia/Shanghai. */
  cron: string;
  isEnabled: boolean;
  template: PushTemplate;
  channels: PushRuleChannel[];
}

/** One delivery outcome returned by NotificationPushService.pushToChannel. */
export interface PushDeliveryOutcome {
  success: true;
  renderedTitle: string;
  renderedContent: string;
  /** UTC instant the message was handed to the WeCom webhook. */
  sentAt: string;
}

/** One delivery record produced by a rule execution (after persist). */
export interface PushDeliveryRecord {
  /** Id of the persisted push_delivery row. */
  id: string;
  channelId: string;
  /** Channel name denormalized for the API response (no join needed later). */
  channelName: string;
  status: PushDeliveryStatus;
  /** WeCom errcode on a WeCom-layer failure; null otherwise. */
  wecomErrCode: number | null;
  /** WeCom errmsg (or short reason) on failure; never a webhook URL. */
  wecomErrMsg: string | null;
  /** UTC instant handed to WeCom; null when no outbound call happened. */
  sentAt: string | null;
}

/**
 * One phase of a push run's execution, with wall-clock duration (issue #70).
 * Written into the PUSH_DONE assistant event's payload so the panel's
 * "执行过程" bar can show 同步→匹配→生成→发出 segment timings without a
 * separate table. `name` is a stable machine key; the web maps it to a label.
 */
export interface PushStagesTiming {
  name: 'sync' | 'match' | 'render' | 'deliver';
  elapsedMs: number;
}

/** Result of one rule execution (all channels). */
export interface ExecuteRuleResult {
  /** True when the run was deduped (SCHEDULED + same rule/windowDate already ran). */
  alreadyPushed: boolean;
  /** Id of the push_log row; null when alreadyPushed. */
  pushLogId: string | null;
  /** The Shanghai window date the run targeted (useful for audit/display). */
  windowDate: string;
  /** Aggregate outcome; null when alreadyPushed. */
  status: PushStatus | null;
  deliveries: PushDeliveryRecord[];
}
