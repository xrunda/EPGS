import { NotFoundException } from '@nestjs/common';

/** Thrown when a notification_channel id does not resolve to any row. */
export class NotificationChannelNotFoundException extends NotFoundException {
  constructor(channelId: string) {
    super({
      code: 'NOTIFICATION_CHANNEL_NOT_FOUND',
      message: `Notification channel ${channelId} was not found.`,
    });
  }
}
