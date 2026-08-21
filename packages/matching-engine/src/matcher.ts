import type {
  MatchDisclaimer,
  MatchInput,
  MatchOccurrence,
  MatchResult,
  MatchableTextField,
  MatchedRule,
  MonitorLevel,
  RuleSnapshot,
} from './types';
import { LEVEL_PRIORITY } from './types';
import { normalizeForMatch } from './normalize';
import { buildContextSnippet } from './context-snippet';
import { getStrategy } from './strategies';

const DISCLAIMER_MESSAGE = '仅用于监测，不作为正式诊断';

/**
 * Resolves which concrete text field(s) a rule's `matchField` should be
 * checked against. `FINDINGS` -> just findings; `IMPRESSION` -> just
 * impression; anything else (`REPORT_TEXT`, `OTHER`, `STUDY_DESCRIPTION`)
 * is treated as "check everything this engine has", satisfying the
 * issue's "ALL 同时检查检查所见和诊断意见" requirement even though the
 * current MatchField enum (schema.prisma) has no literal `ALL` value.
 * See RuleSnapshot.matchField doc in types.ts for the full rationale.
 */
function resolveFieldsForRule(matchField: RuleSnapshot['matchField']): MatchableTextField[] {
  if (matchField === 'FINDINGS') {
    return ['FINDINGS'];
  }
  if (matchField === 'IMPRESSION') {
    return ['IMPRESSION'];
  }
  return ['FINDINGS', 'IMPRESSION'];
}

function getFieldText(input: MatchInput, field: MatchableTextField): string | null {
  return field === 'FINDINGS' ? input.describeText : input.diagnoseText;
}

function levelRank(level: MonitorLevel): number {
  const idx = LEVEL_PRIORITY.indexOf(level);
  return idx === -1 ? LEVEL_PRIORITY.length : idx;
}

/**
 * The monitoring-only disclaimer is a fixed constant on every result
 * (issue #26): no review/disposition status is carried into matching
 * anymore, so there is nothing caller-driven to echo.
 */
function buildDisclaimer(): MatchDisclaimer {
  return {
    monitoringOnly: true,
    message: DISCLAIMER_MESSAGE,
  };
}

/**
 * Matches one report snapshot against a rule snapshot array and returns
 * the highest MonitorLevel plus every piece of matched evidence.
 *
 * PURE FUNCTION CONTRACT: this function reads only its arguments, performs
 * no I/O, and returns a freshly constructed result object every call - it
 * never mutates `input` or any `RuleSnapshot` in `input.rules`. Calling it
 * twice with equal (deep-equal) inputs always yields deep-equal outputs.
 */
export function matchReport(input: MatchInput): MatchResult {
  const normalizedFindings =
    input.describeText !== null ? normalizeForMatch(input.describeText) : null;
  const normalizedImpression =
    input.diagnoseText !== null ? normalizeForMatch(input.diagnoseText) : null;

  const matchedRules: MatchedRule[] = [];

  for (const rule of input.rules) {
    if (!rule.enabled) {
      continue;
    }
    const strategy = getStrategy(rule.matchMode);
    const fields = resolveFieldsForRule(rule.matchField);

    for (const field of fields) {
      const originalText = getFieldText(input, field);
      if (originalText === null || originalText.length === 0) {
        continue;
      }
      const normalizedText = field === 'FINDINGS' ? normalizedFindings! : normalizedImpression!;

      const hits = strategy.findOccurrences(originalText, normalizedText, rule);
      if (hits.length === 0) {
        continue;
      }

      const occurrences: MatchOccurrence[] = hits.map((hit) => ({
        start: hit.start,
        end: hit.end,
        contextSnippet: buildContextSnippet(originalText, hit.start, hit.end),
      }));

      matchedRules.push({
        ruleId: rule.ruleId,
        ruleVersion: rule.ruleVersion,
        keyword: rule.keyword,
        level: rule.level,
        field,
        matchMode: rule.matchMode,
        occurrenceCount: occurrences.length,
        occurrences,
      });
    }
  }

  // Deterministic ordering: by level priority (RED first), then ruleId,
  // then field, so repeated calls with the same input always produce
  // list-identical (not just set-identical) output, per the "纯函数"
  // acceptance criterion.
  matchedRules.sort((a, b) => {
    const levelDiff = levelRank(a.level) - levelRank(b.level);
    if (levelDiff !== 0) return levelDiff;
    const ruleIdDiff = a.ruleId.localeCompare(b.ruleId);
    if (ruleIdDiff !== 0) return ruleIdDiff;
    return a.field.localeCompare(b.field);
  });

  const level: MonitorLevel =
    matchedRules.length === 0
      ? 'UNCLASSIFIED'
      : matchedRules.reduce<MonitorLevel>(
          (best, m) => (levelRank(m.level) < levelRank(best) ? m.level : best),
          'UNCLASSIFIED',
        );

  return {
    reportId: input.reportId,
    reportVersion: input.reportVersion,
    level,
    matchedRules,
    disclaimer: buildDisclaimer(),
  };
}
