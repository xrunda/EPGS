import { PushChannel, PushDeliveryStatus, PushRule, PushStatus, PushTemplate, PushTrigger } from './types';
import { ScheduledPushAlreadyExistsError } from './errors';

/**
 * Data-access seam for the shared push pipeline (issue: push rules). Both
 * apps implement it over their own Prisma client - apps/api/src/notifications
 * /notification-push.adapters.ts and apps/worker/src/notification-push/
 * worker-notification-push-store.ts - so this package never imports
 * @prisma/client (each app owns a generated client).
 *
 * Every method returns STRUCTURAL shapes (see types.ts) with relations
 * preloaded; row-level shapes live here.
 */

/** A push_log row as persisted. */
export interface PushLogRow {
  id: string;
  ruleId: string;
  windowDate: string;
  trigger: PushTrigger;
  /** Aggregate status; null while the run is in flight. */
  status: PushStatus | null;
  errorSummary: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface CreatePushLogInput {
  ruleId: string;
  windowDate: string;
  trigger: PushTrigger;
  startedAt: Date;
}

export interface CreatePushDeliveryInput {
  pushLogId: string;
  channelId: string;
  status: PushDeliveryStatus;
  wecomErrCode: number | null;
  wecomErrMsg: string | null;
  /** UTC instant handed to WeCom; null when no outbound call happened. */
  sentAt: string | null;
}

/** A push_delivery row as persisted (id only; the api re-reads for the DTO list). */
export interface PushDeliveryRow {
  id: string;
}

export interface CompletePushLogInput {
  pushLogId: string;
  status: PushStatus;
  finishedAt: Date;
  /** Free-text summary for FAILED/PARTIAL runs; null for SUCCESS. */
  errorSummary: string | null;
}

export interface NotificationPushStore {
  /** Loads a rule with its template + channels (each channel preloaded). Null when missing. */
  getRule(ruleId: string): Promise<PushRule | null>;
  /** All enabled rules, template + channels preloaded (worker's scheduled tick). */
  listEnabledRules(): Promise<PushRule[]>;
  /** Loads a channel row. Null when missing. */
  getChannel(channelId: string): Promise<PushChannel | null>;
  /** Loads a template row. Null when missing. */
  getTemplate(templateId: string): Promise<PushTemplate | null>;
  /** The existing SCHEDULED run for (rule, windowDate), if any (app-layer dedup guard). */
  findScheduledPush(ruleId: string, windowDate: string): Promise<PushLogRow | null>;
  /**
   * Creates a push_log row. Throws ScheduledPushAlreadyExistsError when the
   * partial unique index uq_push_log_scheduled_dedup rejects a SCHEDULED
   * (rule, windowDate) that already exists - the DB-level race backstop
   * behind findScheduledPush. MANUAL rows never hit that index.
   */
  createPushLog(input: CreatePushLogInput): Promise<PushLogRow>;
  /** Records one channel's delivery outcome inside a push_log; returns the row id. */
  createPushDelivery(input: CreatePushDeliveryInput): Promise<PushDeliveryRow>;
  /** Marks a push_log finished with its aggregate status + optional error summary. */
  completePushLog(input: CompletePushLogInput): Promise<void>;
}

export { ScheduledPushAlreadyExistsError };
