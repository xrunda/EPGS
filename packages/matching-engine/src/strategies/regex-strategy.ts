import type { RuleSnapshot } from '../types';
import type { MatchStrategy, StrategyHit } from './types';

/**
 * REGEX mode: rule.keyword is compiled as a JS regular expression body
 * (no surrounding slashes) and searched against the normalized text with
 * the `g` flag (and `i` unless caseSensitive is true). This is the most
 * powerful and most operator-error-prone mode - an invalid pattern is
 * treated as "this rule matches nothing" rather than throwing, so one bad
 * rule can never crash matchReport for an entire batch of reports.
 */
export class RegexStrategy implements MatchStrategy {
  readonly mode: RuleSnapshot['matchMode'] = 'REGEX';

  findOccurrences(_originalText: string, normalizedText: string, rule: RuleSnapshot): StrategyHit[] {
    const caseSensitive = rule.caseSensitive ?? false;
    let re: RegExp;
    try {
      re = new RegExp(rule.keyword, caseSensitive ? 'g' : 'gi');
    } catch {
      // Malformed regex authored by an operator - fail closed (no match),
      // not a thrown exception. Rule authoring/validation is issue #4's
      // concern; this engine must stay resilient to bad input.
      return [];
    }

    const hits: StrategyHit[] = [];
    let match: RegExpExecArray | null;
    let lastIndex = -1;
    while ((match = re.exec(normalizedText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // Guard against zero-length matches causing an infinite loop.
      if (end === start) {
        re.lastIndex = start + 1;
      }
      if (start === lastIndex) {
        // Defensive: never emit a duplicate at the same start twice in a row.
        continue;
      }
      hits.push({ start, end });
      lastIndex = start;
      if (re.lastIndex > normalizedText.length) {
        break;
      }
    }
    return hits;
  }
}
