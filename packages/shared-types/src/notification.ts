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
