/**
 * Framework-agnostic domain errors thrown by the shared push pipeline
 * (issue: push rules). Each app maps them to its own transport: apps/api
 * translates them into the existing Nest exceptions with the same error codes
 * the notification APIs already contract (NOTIFICATION_CHANNEL_NOT_FOUND etc.),
 * so the public HTTP contract is unchanged by this refactor. The worker
 * scheduler treats them as per-channel failures to record, never as fatal.
 */

export class NotificationChannelNotFoundError extends Error {
  constructor(channelId: string) {
    super(`Notification channel ${channelId} was not found.`);
    this.name = 'NotificationChannelNotFoundError';
  }
}

export class NotificationChannelDisabledError extends Error {
  constructor(channelId: string) {
    super(`Notification channel ${channelId} is disabled.`);
    this.name = 'NotificationChannelDisabledError';
  }
}

export class NotificationTemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Notification template ${templateId} was not found.`);
    this.name = 'NotificationTemplateNotFoundError';
  }
}

export class NotificationTemplateDisabledError extends Error {
  constructor(templateId: string) {
    super(`Notification template ${templateId} is disabled.`);
    this.name = 'NotificationTemplateDisabledError';
  }
}

export class NotificationRuleNotFoundError extends Error {
  constructor(ruleId: string) {
    super(`Notification rule ${ruleId} was not found.`);
    this.name = 'NotificationRuleNotFoundError';
  }
}

/**
 * Raised by the store adapter's createPushLog when the partial unique index
 * uq_push_log_scheduled_dedup rejects a SCHEDULED row (rule_id + window_date
 * already exists). The executor treats this as "already pushed" - a race
 * backstop to the application-layer findScheduledPush guard.
 */
export class ScheduledPushAlreadyExistsError extends Error {
  constructor(ruleId: string, windowDate: string) {
    super(`Scheduled push for rule ${ruleId} on ${windowDate} already exists.`);
    this.name = 'ScheduledPushAlreadyExistsError';
  }
}
