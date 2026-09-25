import { MonitorRule } from '@prisma/client';
import { MonitorRuleDto } from '@epgs/shared-types';

/** Maps a Prisma MonitorRule row to the wire-level DTO (ISO date strings, etc). */
export function toRuleDto(rule: MonitorRule): MonitorRuleDto {
  return {
    id: rule.id,
    keyword: rule.keyword,
    level: rule.level,
    matchField: rule.matchField,
    matchMode: rule.matchMode,
    category: rule.category,
    // Issue #87: passed through verbatim. Deliberately NOT defaulted to a
    // template - the doctor's own words are the intent, and a placeholder
    // would be judged by the model as if the doctor had written it.
    semanticIntent: rule.semanticIntent,
    isEnabled: rule.isEnabled,
    version: rule.version,
    ruleGroupId: rule.ruleGroupId,
    notes: rule.notes,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    createdBy: rule.createdBy,
    updatedBy: rule.updatedBy,
  };
}
