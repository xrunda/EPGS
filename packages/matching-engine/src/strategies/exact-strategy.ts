import type { RuleSnapshot } from '../types';
import { toComparisonCase } from '../normalize';
import type { MatchStrategy, StrategyHit } from './types';

/**
 * EXACT mode ("精确短语"): the field text must contain the keyword as a
 * whole, delimiter-bounded phrase - i.e. the keyword occurrence must not
 * be directly adjacent to another CJK/alphanumeric character on either
 * side (so "胃溃疡" as an EXACT keyword matches inside "诊断：胃溃疡。"
 * but a keyword "溃疡" does NOT match inside "胃溃疡病灶" if that would
 * only be a sub-phrase of a larger contiguous word/phrase). This is
 * deliberately stricter than CONTAINS (pure substring) while remaining a
 * plain textual/boundary check - no tokenizer, no dictionary, no
 * negation semantics, consistent with issue #5's "不擅自实现医学否定语义"
 * and "不使用大模型" constraints.
 *
 * Boundary characters (treated as "not part of a word") are: whitespace,
 * common CJK/ASCII punctuation, and start/end of string. Anything else
 * (CJK ideographs, ASCII letters/digits) is treated as "part of a word".
 */
const BOUNDARY_PATTERN = /[\s,.;:!?，。；：！？、（）()【】[\]"“”'‘’《》<>\-—_/\\]/;

function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) {
    return true;
  }
  return BOUNDARY_PATTERN.test(ch);
}

export class ExactStrategy implements MatchStrategy {
  readonly mode: RuleSnapshot['matchMode'] = 'EXACT';

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
      const end = idx + keyword.length;
      const before = idx > 0 ? haystack[idx - 1] : undefined;
      const after = end < haystack.length ? haystack[end] : undefined;
      if (isBoundary(before) && isBoundary(after)) {
        hits.push({ start: idx, end });
      }
      fromIndex = idx + 1;
    }
    return hits;
  }
}
