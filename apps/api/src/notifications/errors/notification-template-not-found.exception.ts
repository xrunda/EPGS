import { NotFoundException } from '@nestjs/common';

/** Thrown when a notification_template id does not resolve to any row. */
export class NotificationTemplateNotFoundException extends NotFoundException {
  constructor(templateId: string) {
    super({
      code: 'NOTIFICATION_TEMPLATE_NOT_FOUND',
      message: `Notification template ${templateId} was not found.`,
    });
  }
}
