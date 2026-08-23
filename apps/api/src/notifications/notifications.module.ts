import { Module } from '@nestjs/common';
import { NotificationSecretCipher } from './notification-secret-cipher.service';

/**
 * Issue #53 scope: data model + encryption infrastructure only. The
 * controllers/services that expose notification_channel/notification_
 * template as HTTP APIs (GET/POST/PUT, test-send) land in issue #54 and
 * will be added to this module's controllers/providers at that point.
 */
@Module({
  providers: [NotificationSecretCipher],
  exports: [NotificationSecretCipher],
})
export class NotificationsModule {}
