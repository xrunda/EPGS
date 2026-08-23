import { Module } from '@nestjs/common';
import { NotificationSecretCipher } from './notification-secret-cipher.service';
import { NotificationsService } from './notifications.service';
import { NotificationTestSendService } from './notification-test-send.service';
import { WecomWebhookSender } from './wecom-webhook-sender';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationTemplatesController } from './notification-templates.controller';
import { AuditModule } from '../audit/audit.module';
import { MonitorModule } from '../monitor/monitor.module';

/**
 * Issue #54: channel/template management APIs + WeCom test-send, built on
 * issue #53's data model + NotificationSecretCipher.
 *
 * DI notes:
 * - MonitorModule is imported (not PrismaModule - that one is @Global) so
 *   NotificationTestSendService can render templates from the live
 *   MonitorService.summary counts. MonitorService was added to
 *   MonitorModule's exports for exactly this.
 * - WecomWebhookSender is constructed with default options (10s timeout,
 *   global fetch) - tests/e2e override the provider with a fake or a
 *   MockAgent-bound fetchImpl.
 */
@Module({
  imports: [AuditModule, MonitorModule],
  controllers: [NotificationChannelsController, NotificationTemplatesController],
  providers: [
    NotificationsService,
    NotificationTestSendService,
    NotificationSecretCipher,
    {
      provide: WecomWebhookSender,
      useFactory: () => new WecomWebhookSender({ timeoutMs: 10_000 }),
    },
  ],
  exports: [NotificationSecretCipher, NotificationsService],
})
export class NotificationsModule {}
