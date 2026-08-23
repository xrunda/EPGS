import { BadRequestException } from '@nestjs/common';

/**
 * Thrown when test-send targets a notification_channel with is_enabled =
 * false. Test-send must never push to a channel the operator has switched
 * off - a message that slips through a disabled channel would look like the
 * config UI's "test" worked while the real one is intentionally muted.
 */
export class NotificationChannelDisabledException extends BadRequestException {
  constructor(channelId: string) {
    super({
      code: 'NOTIFICATION_CHANNEL_DISABLED',
      message: `Notification channel ${channelId} is disabled. Enable it before sending a test.`,
    });
  }
}
