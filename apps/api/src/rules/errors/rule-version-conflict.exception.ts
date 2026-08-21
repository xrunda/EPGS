import { ConflictException } from '@nestjs/common';

/**
 * Thrown when a PUT /api/rules/{id} request's `version` field does not
 * match the row's current version - i.e. someone else changed the rule
 * since the client last read it. This is the optimistic-lock mechanism
 * issue #4 asks for, built on MonitorRule.version (see schema.prisma).
 */
export class RuleVersionConflictException extends ConflictException {
  constructor(ruleId: string, expectedVersion: number, actualVersion: number) {
    super({
      code: 'RULE_VERSION_CONFLICT',
      message: `Rule ${ruleId} was modified by another operator (expected version ${expectedVersion}, current version is ${actualVersion}). Reload and retry.`,
      details: { conflictingRuleId: ruleId, expectedVersion, actualVersion },
    });
  }
}
