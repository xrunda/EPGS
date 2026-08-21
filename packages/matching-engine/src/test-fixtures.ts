import type { MatchInput, RuleSnapshot } from './types';

/** Test-only helper: builds a RuleSnapshot with sane defaults, overridable per test. */
export function buildRule(
  overrides: Partial<RuleSnapshot> & Pick<RuleSnapshot, 'ruleId' | 'keyword' | 'level'>,
): RuleSnapshot {
  return {
    ruleVersion: 1,
    matchField: 'REPORT_TEXT',
    matchMode: 'CONTAINS',
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

/** Test-only helper: builds a MatchInput with sane defaults, overridable per test. */
export function buildInput(overrides: Partial<MatchInput> & { rules: RuleSnapshot[] }): MatchInput {
  return {
    reportId: 'report-1',
    reportVersion: 1,
    describeText: null,
    diagnoseText: null,
    ...overrides,
  };
}
