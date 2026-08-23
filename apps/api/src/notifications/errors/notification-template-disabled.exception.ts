import { BadRequestException } from '@nestjs/common';

/**
 * Thrown when test-send targets a notification_template with is_enabled =
 * false. Same rationale as NotificationChannelDisabledException - a test
 * push must not use a template the operator has switched off.
 */
export class NotificationTemplateDisabledException extends BadRequestException {
  constructor(templateId: string) {
    super({
      code: 'NOTIFICATION_TEMPLATE_DISABLED',
      message: `Notification template ${templateId} is disabled. Enable it before sending a test.`,
    });
  }
}
