import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlertLinkIssuer,
  NotificationPushService,
  NotificationRuleExecutor,
  NotificationSecretCipher,
  WecomWebhookSender,
} from '@epgs/notification-push';
import { NotificationsService } from './notifications.service';
import { NotificationTestSendService } from './notification-test-send.service';
import { NotificationRulesService } from './notification-rules.service';
import {
  PrismaNotificationPushStore,
  MonitorSummaryProvider,
  PrismaAlertLinkStore,
} from './notification-push.adapters';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationRulesController } from './notification-rules.controller';
import { NotificationPushLogsController } from './notification-push-logs.controller';
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
  ],
  providers: [
    NotificationsService,
    NotificationTestSendService,
    NotificationRulesService,
    PrismaNotificationPushStore,
    MonitorSummaryProvider,
    PrismaAlertLinkStore,
    {
      // Issue #72: per-level alert links appended to a manual "run now".
      // Disabled (no cards) unless ALERT_LINK_BASE_URL is configured.
      provide: AlertLinkIssuer,
      inject: [PrismaAlertLinkStore, MonitorSummaryProvider, ConfigService],
      useFactory: (store: PrismaAlertLinkStore, summary: MonitorSummaryProvider, config: ConfigService) =>
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
      inject: [PrismaNotificationPushStore, NotificationPushService, AlertLinkIssuer],
      useFactory: (
        store: PrismaNotificationPushStore,
        push: NotificationPushService,
        alertLinks: AlertLinkIssuer,
      ) => new NotificationRuleExecutor({ store, push, alertLinks }),
    },
  ],
  exports: [NotificationSecretCipher, NotificationsService],
})
export class NotificationsModule {}
