import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationPushService,
  NotificationRuleExecutor,
  NotificationSecretCipher,
  WecomWebhookSender,
} from '@epgs/notification-push';
import { NotificationsService } from './notifications.service';
import { NotificationTestSendService } from './notification-test-send.service';
import { NotificationRulesService } from './notification-rules.service';
import { PrismaNotificationPushStore, MonitorSummaryProvider } from './notification-push.adapters';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationRulesController } from './notification-rules.controller';
import { NotificationPushLogsController } from './notification-push-logs.controller';
import { PushAssistantController } from './push-assistant.controller';
import { PushAssistantService } from './push-assistant.service';
import { AuditModule } from '../audit/audit.module';
import { MonitorModule } from '../monitor/monitor.module';

/**
 * Issue #54/#55/#58/#59/#60: channel/template management APIs + WeCom
 * test-send; issue: push rules adds scheduled rules + manual "run now".
 *
 * DI notes:
 * - MonitorModule is imported (not PrismaModule - that one is @Global) so
 *   the push pipeline can render templates from the live
 *   MonitorService.summary counts (the same source the workbench uses).
 * - The shared @epgs/notification-push pipeline is assembled here: the
 *   store/summary are api adapters over PrismaService + MonitorService, the
 *   cipher/sender are constructed with the same env/config as before, and
 *   NotificationPushService + NotificationRuleExecutor bind the chain.
 * - WecomWebhookSender is constructed with default options (10s timeout,
 *   global fetch) - tests/e2e override the provider with a fake or a
 *   MockAgent-bound fetchImpl.
 */
@Module({
  imports: [AuditModule, MonitorModule],
  controllers: [
    NotificationChannelsController,
    NotificationTemplatesController,
    NotificationRulesController,
    NotificationPushLogsController,
    PushAssistantController,
  ],
  providers: [
    NotificationsService,
    NotificationTestSendService,
    NotificationRulesService,
    PushAssistantService,
    PrismaNotificationPushStore,
    MonitorSummaryProvider,
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
      inject: [PrismaNotificationPushStore, NotificationSecretCipher, WecomWebhookSender, MonitorSummaryProvider, ConfigService],
      useFactory: (
        store: PrismaNotificationPushStore,
        cipher: NotificationSecretCipher,
        sender: WecomWebhookSender,
        summary: MonitorSummaryProvider,
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
      inject: [PrismaNotificationPushStore, NotificationPushService],
      useFactory: (store: PrismaNotificationPushStore, push: NotificationPushService) =>
        new NotificationRuleExecutor({ store, push }),
    },
  ],
  exports: [NotificationSecretCipher, NotificationsService],
})
export class NotificationsModule {}
