/**
 * Stable DTOs for the notification channel/template APIs + test-send
 * (issue #54).
 *
 * These mirror apps/api's Prisma `NotificationChannel` / `NotificationTemplate`
 * models at the wire level so apps/web (issue #55's config UI) and any other
 * consumer can share a single type definition. See
 * apps/api/prisma/schema.prisma and docs/data-dictionary.md for the
 * authoritative field-level documentation and
 * docs/notification-design.md §3/§4/§5 for the design rationale.
 *
 * SECURITY CONTRACT (design §5): a channel's `webhookUrl` is stored as
 * AES-256-GCM ciphertext and is NEVER returned by any endpoint. The read
 * field is `webhookUrlMasked` (e.g. `...key=8d24****`) - the masked value is
 * deliberately a DIFFERENT field name from the writable `webhookUrl`, so a
 * masked read value can never be accidentally echoed back into PUT as if it
 * were the real webhook URL.
 */

/** Message shape of a template. Mirrors Prisma's NotificationMsgType enum. */
export type NotificationMsgTypeDto = 'TEXT' | 'NEWS';

/** One notification_channel row as returned by the API. */
export interface NotificationChannelDto {
  id: string;
  name: string;
  /** Masked preview of the WeCom webhook URL - the plaintext is never returned. */
  webhookUrlMasked: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Paginated response envelope for `GET /api/notification-channels`. */
export interface PaginatedNotificationChannels {
  items: NotificationChannelDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Query params for `GET /api/notification-channels`. */
export interface ListNotificationChannelsQuery {
  isEnabled?: boolean;
  page?: number;
  pageSize?: number;
}

/** Body for `POST /api/notification-channels`. */
export interface CreateNotificationChannelBody {
  name: string;
  /** Plaintext WeCom webhook URL, encrypted at rest by the API. */
  webhookUrl: string;
  isEnabled?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId?: string;
}

/**
 * Body for `PUT /api/notification-channels/{id}`. All fields optional.
 * `webhookUrl` is WRITE-ONLY: when present it replaces the stored value
 * (and is re-encrypted); when absent the existing ciphertext is kept.
 * The API never echoes the plaintext back, so a client cannot (and need
 * not) submit a masked value here.
 */
export interface UpdateNotificationChannelBody {
  name?: string;
  webhookUrl?: string;
  isEnabled?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId?: string;
}

/** One notification_template row as returned by the API. */
export interface NotificationTemplateDto {
  id: string;
  name: string;
  msgType: NotificationMsgTypeDto;
  /** Present only when msgType = NEWS; null otherwise. */
  titleTemplate: string | null;
  contentTemplate: string;
  coverImageUrl: string | null;
  linkUrl: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Paginated response envelope for `GET /api/notification-templates`. */
export interface PaginatedNotificationTemplates {
  items: NotificationTemplateDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Query params for `GET /api/notification-templates`. */
export interface ListNotificationTemplatesQuery {
  msgType?: NotificationMsgTypeDto;
  isEnabled?: boolean;
  page?: number;
  pageSize?: number;
}

/** Body for `POST /api/notification-templates`. */
export interface CreateNotificationTemplateBody {
  name: string;
  msgType: NotificationMsgTypeDto;
  /** Required when msgType = NEWS (service-enforced, code NOTIFICATION_TEMPLATE_TITLE_REQUIRED). */
  titleTemplate?: string;
  contentTemplate: string;
  coverImageUrl?: string | null;
  linkUrl?: string | null;
  isEnabled?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId?: string;
}

/** Body for `PUT /api/notification-templates/{id}`. All fields optional. */
export interface UpdateNotificationTemplateBody {
  name?: string;
  msgType?: NotificationMsgTypeDto;
  titleTemplate?: string;
  contentTemplate?: string;
  coverImageUrl?: string | null;
  linkUrl?: string | null;
  isEnabled?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId?: string;
}

/** One entry of the fixed placeholder dictionary (`GET /api/notification-templates/variables`). */
export interface NotificationVariableDto {
  /** Placeholder key, e.g. `redCount` (used as `{{redCount}}` in templates). */
  key: string;
  /** Human-readable label shown in the config UI, e.g. `红色关注数量`. */
  label: string;
  /** Illustrative example value, e.g. `3`. */
  example: string;
}

/** One preset content-template skeleton (`GET /api/notification-templates/presets`). */
export interface NotificationTemplatePresetDto {
  /** Stable preset id, e.g. `red-alert`. */
  id: string;
  /** Human-readable name shown in the config UI, e.g. `红色关注提醒`. */
  name: string;
  /** Message-body skeleton with {{placeholder}} tokens from the variables dictionary. */
  content: string;
}

/** Body for `POST /api/notification-channels/{id}/test-send`. */
export interface TestSendBody {
  templateId: string;
}

/** Success response for `POST /api/notification-channels/{id}/test-send`. */
export interface TestSendResult {
  success: true;
  /** Rendered template title; always '' for msgType = TEXT. */
  renderedTitle: string;
  /** Rendered template content after {{placeholder}} substitution. */
  renderedContent: string;
  /** UTC instant the message was handed to the WeCom webhook, ISO 8601. */
  sentAt: string;
}

/** Nested under ApiErrorBody.error.details for NOTIFICATION_SEND_FAILED (502). */
export interface NotificationSendFailureDetails {
  wecomErrCode: number;
  wecomErrMsg: string;
}

// ---------------------------------------------------------------------------
// Push rules + push logs (issue: push rules). These mirror apps/api's Prisma
// `NotificationRule` / `PushLog` / `PushDelivery` models at the wire level;
// the authoritative field documentation lives in schema.prisma and
// docs/notification-design.md §10 (the push-rules addendum).
// ---------------------------------------------------------------------------

/** Why a push_log row was created. Mirrors Prisma's NotificationPushTrigger enum. */
export type NotificationPushTriggerDto = 'SCHEDULED' | 'MANUAL';

/** Aggregate run status across all of a rule's channels. Mirrors NotificationPushStatus. */
export type NotificationPushStatusDto = 'SUCCESS' | 'PARTIAL' | 'FAILED';

/** Per-channel delivery outcome. Mirrors NotificationPushDeliveryStatus. */
export type NotificationPushDeliveryStatusDto = 'SUCCESS' | 'FAILED';

/** One channel bound to a rule (denormalized id + name for list display). */
export interface NotificationRuleChannelDto {
  id: string;
  channelId: string;
  /** Human-readable channel name, e.g. "内镜中心红色关注群". */
  name: string;
}

/** One notification_rule row as returned by the API. */
export interface NotificationRuleDto {
  id: string;
  name: string;
  /** 5-field cron expression (minute-hour-day-month-dow), Asia/Shanghai. */
  cron: string;
  templateId: string;
  /** Template name denormalized for list display. */
  templateName: string;
  /** Channels bound to this rule, in binding order. */
  channels: NotificationRuleChannelDto[];
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Paginated response envelope for `GET /api/notification-rules`. */
export interface PaginatedNotificationRules {
  items: NotificationRuleDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Query params for `GET /api/notification-rules`. */
export interface ListNotificationRulesQuery {
  isEnabled?: boolean;
  page?: number;
  pageSize?: number;
}

/** Body for `POST /api/notification-rules`. */
export interface CreateNotificationRuleBody {
  name: string;
  /** 5-field cron expression (minute-hour-day-month-dow), evaluated in Asia/Shanghai. */
  cron: string;
  templateId: string;
  /** At least one channel is required (service-enforced, code NOTIFICATION_RULE_NO_CHANNELS). */
  channelIds: string[];
  isEnabled?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId?: string;
}

/** Body for `PUT /api/notification-rules/{id}`. All fields optional; channelIds replaces the whole binding set. */
export interface UpdateNotificationRuleBody {
  name?: string;
  cron?: string;
  templateId?: string;
  channelIds?: string[];
  isEnabled?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId?: string;
}

/** One delivery row inside a push_log. */
export interface PushDeliveryDto {
  id: string;
  channelId: string;
  /** Channel name denormalized for display (may reference a since-deleted channel). */
  channelName: string;
  status: NotificationPushDeliveryStatusDto;
  /** WeCom errcode on a WeCom-layer failure; null otherwise. */
  wecomErrCode: number | null;
  /** WeCom errmsg (or short reason) on failure; never a webhook URL. */
  wecomErrMsg: string | null;
  /** UTC instant handed to the WeCom webhook; null when no outbound call happened. */
  sentAt: string | null;
}

/** One push_log row as returned by the API, with its deliveries. */
export interface PushLogDto {
  id: string;
  ruleId: string;
  /** Shanghai YYYY-MM-DD summary window this run pushed. */
  windowDate: string;
  trigger: NotificationPushTriggerDto;
  /** Aggregate outcome; null only while the run is in flight. */
  status: NotificationPushStatusDto | null;
  errorSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
  deliveries: PushDeliveryDto[];
}

/** Paginated response envelope for `GET /api/notification-rules/:id/push-logs`. */
export interface PaginatedPushLogs {
  items: PushLogDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Query params for `GET /api/notification-rules/:id/push-logs`. */
export interface ListPushLogsQuery {
  page?: number;
  pageSize?: number;
}

/** Success response for `POST /api/notification-rules/:id/run` (manual "run now"). */
export interface RunNotificationRuleResult {
  /** True when the run was deduped because today's SCHEDULED push already ran. */
  alreadyPushed: boolean;
  /** Id of the push_log row for this run; null when alreadyPushed. */
  pushLogId: string | null;
  /** Aggregate outcome; null when alreadyPushed. */
  status: NotificationPushStatusDto | null;
  deliveries: PushDeliveryDto[];
}
