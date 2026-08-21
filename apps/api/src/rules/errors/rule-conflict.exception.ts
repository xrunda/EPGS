import { ConflictException } from '@nestjs/common';
import { RuleConflictDetails } from '@epgs/shared-types';

/**
 * Thrown when a new/edited rule would duplicate an existing ENABLED rule
 * on the same (keyword, level, matchField, matchMode) tuple - see
 * RulesService.assertNoConflict for the uniqueness policy and
 * docs/rules-api.md for why this is global rather than per-department.
 *
 * Produces the machine-readable body issue #4 asks for:
 *   { error: { code: 'RULE_CONFLICT', message, correlationId, details: { conflictingRuleId } } }
 * via GlobalExceptionFilter, which reads `code`/`details` off the
 * HttpException response object.
 */
export class RuleConflictException extends ConflictException {
  constructor(conflictingRuleId: string, message = 'An enabled rule with the same keyword, level, match scope and match mode already exists.') {
    const details: RuleConflictDetails = { conflictingRuleId };
    super({
      code: 'RULE_CONFLICT',
      message,
      details,
    });
  }
}
