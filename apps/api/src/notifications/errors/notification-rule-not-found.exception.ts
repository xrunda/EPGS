import { NotFoundException } from '@nestjs/common';

/** Thrown when a notification_rule id does not resolve to any row. */
export class NotificationRuleNotFoundException extends NotFoundException {
  constructor(ruleId: string) {
    super({
      code: 'NOTIFICATION_RULE_NOT_FOUND',
      message: `Notification rule ${ruleId} was not found.`,
    });
  }
}
