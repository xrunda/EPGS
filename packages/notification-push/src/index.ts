/**
 * @epgs/notification-push - the shared WeCom notification push pipeline
 * (issue: push rules). Consumed by apps/api (test-send + manual rule run) and
 * apps/worker (scheduled rule tick). Framework- and DB-agnostic: every app
 * supplies its own NotificationPushStore + NotificationSummaryProvider
 * adapters, so this package never imports @prisma/client.
 */
export * from './types';
export * from './errors';
export * from './store';
export * from './summary';
export * from './render';
export * from './cron';
export * from './wecom-webhook-sender';
export { NotificationSecretCipher } from './notification-secret-cipher';
export { NotificationPushService } from './push.service';
export type {
  NotificationPushServiceDeps,
  PushToChannelInput,
} from './push.service';
export { NotificationRuleExecutor } from './rule-executor';
export type { NotificationRuleExecutorDeps, ExecuteRuleInput } from './rule-executor';
