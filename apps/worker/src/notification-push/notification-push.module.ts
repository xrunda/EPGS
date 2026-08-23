import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationPushService,
  NotificationRuleExecutor,
  NotificationSecretCipher,
  WecomWebhookSender,
} from '@epgs/notification-push';
import { WorkerNotificationPushStore } from './worker-notification-push-store';
import { WorkerSummaryProvider } from './worker-summary.provider';
import { NotificationScheduler } from './notification-scheduler.service';

/**
 * Scheduled WeCom push rules (issue: push rules) - the worker half of the
 * shared @epgs/notification-push pipeline. Assembled exactly like the api's
 * NotificationModule: the store/summary are worker adapters over the worker's
 * own PrismaService, and the cipher/sender are constructed from config so the
 * worker can decrypt webhook URLs (with the SAME NOTIFICATION_SECRET_KEY as
 * the api) and push to WeCom directly.
 */
@Module({
  providers: [
    WorkerNotificationPushStore,
    WorkerSummaryProvider,
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
      inject: [WorkerNotificationPushStore, NotificationPushService],
      useFactory: (store: WorkerNotificationPushStore, push: NotificationPushService) =>
        new NotificationRuleExecutor({ store, push }),
    },
    NotificationScheduler,
  ],
  exports: [NotificationScheduler],
})
export class NotificationPushModule {}
