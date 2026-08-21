import type { RuleSnapshot } from '../types';

/**
 * One raw occurrence found by a MatchStrategy, before context-snippet
 * enrichment. Offsets are into the ORIGINAL (non-normalized) field text -
 * see normalize.ts for why this is safe (1:1 index-preserving
 * normalization).
 */
export interface StrategyHit {
  start: number;
  end: number;
}

/**
 * Pluggable matching strategy: given a rule and the ORIGINAL field text,
 * return every raw occurrence of that rule's keyword in the text.
 *
 * This interface exists so future issues can add new strategies (e.g. a
 * negation-aware strategy that suppresses "未见肿物"-style hits, or a
 * fuzzy/pinyin strategy) WITHOUT changing matcher.ts's aggregation logic.
 * Per issue #5's explicit non-goal, no negation-detection strategy is
 * implemented here - CONTAINS/EXACT/REGEX all match plain textual
 * occurrence, including inside negated phrases like "未见肿物", by design
 * (a human must review/mark false positives; see MonitorAction
 * MARKED_FALSE_POSITIVE in the Prisma schema).
 */
export interface MatchStrategy {
  readonly mode: RuleSnapshot['matchMode'];
  /**
   * @param originalText   The untouched field text (for slicing final offsets/snippets).
   * @param normalizedText Same text after normalizeForMatch (full-width -> half-width), same length/index alignment as originalText.
   * @param rule           The rule being evaluated (keyword + caseSensitive flag).
   */
  findOccurrences(originalText: string, normalizedText: string, rule: RuleSnapshot): StrategyHit[];
}
