import { NotFoundException } from '@nestjs/common';

/** Thrown when a rule id does not resolve to any (any version, any enabled state) row. */
export class RuleNotFoundException extends NotFoundException {
  constructor(ruleId: string) {
    super({
      code: 'RULE_NOT_FOUND',
      message: `Rule ${ruleId} was not found.`,
    });
  }
}
