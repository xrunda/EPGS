import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlertLinkIssuer,
  NotificationPushService,
  NotificationRuleExecutor,
  NotificationSecretCipher,
  WecomWebhookSender,
} from '@epgs/notification-push';
import { WorkerNotificationPushStore } from './worker-notification-push-store';
import { WorkerSummaryProvider } from './worker-summary.provider';
import { WorkerAlertLinkStore } from './worker-alert-link.store';
import { NotificationScheduler } from './notification-scheduler.service';
import { AssistantModule } from '../assistant/assistant.module';

/**
 * Scheduled WeCom push rules (issue: push rules) - the worker half of the
 * shared @epgs/notification-push pipeline. Assembled exactly like the api's
 * NotificationModule: the store/summary are worker adapters over the worker's
 * own PrismaService, and the cipher/sender are constructed from config so the
 * worker can decrypt webhook URLs (with the SAME NOTIFICATION_SECRET_KEY as
 * the api) and push to WeCom directly.
 */
@Module({
  imports: [AssistantModule],
  providers: [
    WorkerNotificationPushStore,
    WorkerSummaryProvider,
    WorkerAlertLinkStore,
    {
      // Issue #72: per-level alert links appended to scheduled runs. Disabled
      // (no cards) unless ALERT_LINK_BASE_URL is configured - same value as api.
      provide: AlertLinkIssuer,
      inject: [WorkerAlertLinkStore, WorkerSummaryProvider, ConfigService],
      useFactory: (store: WorkerAlertLinkStore, summary: WorkerSummaryProvider, config: ConfigService) =>
        new AlertLinkIssuer({
          store,
          summary,
          baseUrl: config.get<string | null>('alertLinkBaseUrl') ?? null,
          ttlHours: config.get<number>('alertLinkTtlHours') ?? 24,
          hospitalNameProvider: () => config.get<string>('hospitalName') ?? '菏泽市中医医院',
        }),
    },
    {
      provide: NotificationSecretCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new NotificationSecretCipher(config.get<string>('notificationSecretKey') ?? ''),
    },
    {
      provide: WecomWebhookSender,
      useFactory: () => new WecomWebhookSender({ timeoutMs: 10_000 }),
    },
    {
      provide: NotificationPushService,
      inject: [WorkerNotificationPushStore, NotificationSecretCipher, WecomWebhookSender, WorkerSummaryProvider, ConfigService],
      useFactory: (
        store: WorkerNotificationPushStore,
        cipher: NotificationSecretCipher,
        sender: WecomWebhookSender,
        summary: WorkerSummaryProvider,
        config: ConfigService,
      ) =>
        new NotificationPushService({
          store,
          cipher,
          sender,
          summary,
          hospitalNameProvider: () => config.get<string>('hospitalName') ?? '菏泽市中医医院',
        }),
    },
    {
      provide: NotificationRuleExecutor,
      inject: [WorkerNotificationPushStore, NotificationPushService, AlertLinkIssuer],
      useFactory: (
        store: WorkerNotificationPushStore,
        push: NotificationPushService,
        alertLinks: AlertLinkIssuer,
      ) => new NotificationRuleExecutor({ store, push, alertLinks }),
    },
    NotificationScheduler,
  ],
  exports: [NotificationScheduler],
})
export class NotificationPushModule {}
