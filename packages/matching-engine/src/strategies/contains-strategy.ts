import type { RuleSnapshot } from '../types';
import { toComparisonCase } from '../normalize';
import type { MatchStrategy, StrategyHit } from './types';

/**
 * CONTAINS mode: keyword may appear anywhere in the field text
 * (substring match), possibly multiple times. This is the default
 * MatchMode per schema.prisma (`matchMode @default(CONTAINS)`).
 *
 * Deliberately does NOT perform any negation/context analysis - e.g. a
 * keyword "肿物" inside "未见肿物" still counts as a hit here, by design
 * (see strategies/types.ts doc and issue #5's explicit non-goal).
 */
export class ContainsStrategy implements MatchStrategy {
  readonly mode: RuleSnapshot['matchMode'] = 'CONTAINS';

  findOccurrences(originalText: string, normalizedText: string, rule: RuleSnapshot): StrategyHit[] {
    const keyword = rule.keyword;
    if (keyword.length === 0) {
      return [];
    }
    const caseSensitive = rule.caseSensitive ?? false;
    const haystack = toComparisonCase(normalizedText, caseSensitive);
    const needle = toComparisonCase(keyword, caseSensitive);

    const hits: StrategyHit[] = [];
    let fromIndex = 0;
    while (fromIndex <= haystack.length) {
      const idx = haystack.indexOf(needle, fromIndex);
      if (idx === -1) {
        break;
      }
      hits.push({ start: idx, end: idx + keyword.length });
      // Advance by 1 (not needle.length) so overlapping occurrences of a
      // short keyword inside a longer repeated pattern are still all
      // counted - matches the issue's "重复词" requirement of preserving
      // every occurrence count faithfully rather than under-counting.
      fromIndex = idx + 1;
    }
    return hits;
  }
}
