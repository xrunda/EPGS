import { getStrategy, normalizeForMatch } from '@epgs/matching-engine';
import type { MatchMode, RuleSnapshot } from '@epgs/matching-engine';
import { ContextWindow } from './types';
import { SentenceSpan, sentenceIndexAt, splitSentences } from './sentence';

/**
 * Context selection for the Validate Match task (issue #87).
 *
 * WHAT THE ISSUE REQUIRES: include the complete sentence containing the hit;
 * optionally extend to the previous/next sentence or the current section;
 * NEVER default to sending the whole report.
 *
 * THE HAZARD THIS FILE EXISTS TO SOLVE. monitor_match keeps exactly ONE row
 * per (record, rule, field, reportVersion) - verified against Postgres, not
 * assumed - and that row's matchStart points at the FIRST occurrence. So for
 *
 *     十二指肠球部未见明显溃疡；胃窦见巨大溃疡，表面覆白苔
 *
 * the surviving row anchors on the NEGATED occurrence. Judging only the
 * anchor's sentence returns NEGATED+HIGH and filters a report that plainly
 * documents an ulcer: a false negative, which issue #87 forbids trading away
 * for fewer false positives. The window therefore covers the anchor's sentence
 * AND the sentence of every other occurrence of the same keyword in the same
 * field, so the model always sees the report's whole story about that word.
 *
 * Selecting the window over a contiguous run of sentences (rather than
 * stitching non-adjacent sentences together) is deliberate: a stitched window
 * would have to invent separators, and any invented character breaks the
 * invariant that `window.text` is a verbatim slice of the report - which is
 * what makes evidence verification and the stored offsets trustworthy.
 */

/**
 * Re-derive every occurrence of the keyword in the field, using the SAME
 * strategy implementations the deterministic matcher uses. Reusing them rather
 * than re-implementing is the point: a second implementation could disagree
 * with the one that created the match (full-width normalization, case folding,
 * overlapping matches), and then the judge would be reasoning about a
 * different set of hits than the one on record.
 *
 * The RuleSnapshot's identity fields are placeholders: the strategies read
 * only `keyword`, `matchMode` and `caseSensitive`, and this call produces no
 * match rows. Callers that already know the siblings may pass them instead.
 */
export function deriveOccurrences(
  fieldText: string,
  keyword: string,
  matchMode: MatchMode,
  caseSensitive = false,
): Array<{ start: number; end: number }> {
  if (fieldText.length === 0 || keyword.length === 0) {
    return [];
  }

  const rule: RuleSnapshot = {
    ruleId: 'context-window-derivation',
    ruleVersion: 0,
    keyword,
    level: 'UNCLASSIFIED',
    matchField: 'REPORT_TEXT',
    matchMode,
    caseSensitive,
    enabled: true,
  };

  try {
    const normalized = normalizeForMatch(fieldText);
    return getStrategy(matchMode).findOccurrences(fieldText, normalized, rule);
  } catch {
    // An unregistered mode, or a REGEX rule whose pattern is invalid. The
    // caller's anchor occurrence is still usable, so fall back to it rather
    // than failing the whole judgement - context selection must never be the
    // reason a hit goes unjudged.
    return [];
  }
}

/** Input to buildContextWindow. */
export interface BuildContextWindowInput {
  /** The full original field text the keyword matched in. */
  fieldText: string;
  /** Inclusive start of the anchor occurrence. */
  matchStart: number;
  /** Exclusive end of the anchor occurrence. */
  matchEnd: number;
  /** Other occurrences to fold in. When omitted they are re-derived. */
  siblingOccurrences?: ReadonlyArray<{ start: number; end: number }>;
  /** Keyword + mode, needed only when siblings must be re-derived. */
  keyword?: string;
  matchMode?: MatchMode;
  caseSensitive?: boolean;
  /** Soft character budget for the window. */
  charBudget: number;
}

/**
 * Build the context window for one hit.
 *
 * Returns a window whose `text` is always exactly
 * `fieldText.slice(start, end)`. Callers must treat an empty `text` as
 * EMPTY_CONTEXT (fail open, no model call) - this function does not throw for
 * it, because "no usable context" is a normal failure the caller classifies.
 *
 * Two tiers, in priority order:
 *
 *  1. REQUIRED - the contiguous run of sentences covering the anchor
 *     occurrence and every sibling occurrence. Always included, whole. If this
 *     core alone exceeds charBudget it is returned anyway: coverage of the
 *     sentences that decide the verdict outranks the character cap.
 *  2. OPTIONAL - further whole sentences on either side, alternating outward,
 *     for as long as the budget allows. This is the "may extend to the
 *     previous/next sentence or the current section" part of the issue.
 *
 * The effective cap is therefore max(charBudget, coreLength), and the budget
 * is what stops a long field from being sent whole - never what stops a
 * relevant sentence from being sent.
 */
export function buildContextWindow(input: BuildContextWindowInput): ContextWindow {
  const { fieldText, matchStart, matchEnd, charBudget } = input;

  const emptyWindow: ContextWindow = {
    text: '',
    start: 0,
    end: 0,
    isWholeField: fieldText.length === 0,
  };

  // Validate the anchor. A null/absent/out-of-range anchor means we cannot
  // trust where the hit is, and guessing would risk judging the wrong
  // sentence - return empty so the caller fails open.
  if (
    fieldText.length === 0 ||
    !Number.isInteger(matchStart) ||
    !Number.isInteger(matchEnd) ||
    matchStart < 0 ||
    matchEnd <= matchStart ||
    matchEnd > fieldText.length
  ) {
    return emptyWindow;
  }

  const spans = splitSentences(fieldText);
  if (spans.length === 0) {
    return emptyWindow;
  }

  const anchorIndex = sentenceIndexAt(spans, matchStart);
  if (anchorIndex < 0) {
    return emptyWindow;
  }

  // Collect every occurrence worth covering: the anchor plus siblings, either
  // supplied or re-derived.
  const siblings =
    input.siblingOccurrences ??
    (input.keyword && input.matchMode
      ? deriveOccurrences(fieldText, input.keyword, input.matchMode, input.caseSensitive ?? false)
      : []);

  const relevantIndices = new Set<number>([anchorIndex]);
  for (const occurrence of siblings) {
    if (
      Number.isInteger(occurrence.start) &&
      Number.isInteger(occurrence.end) &&
      occurrence.start >= 0 &&
      occurrence.end > occurrence.start &&
      occurrence.end <= fieldText.length
    ) {
      const idx = sentenceIndexAt(spans, occurrence.start);
      if (idx >= 0) {
        relevantIndices.add(idx);
      }
    }
  }

  const budget = Math.max(1, charBudget);

  // THE REQUIRED CORE: the contiguous run of sentences from the first relevant
  // occurrence to the last. This is not a preference - a window that omitted a
  // sibling occurrence's sentence is exactly the window that misjudges
  // "十二指肠球部未见明显溃疡；胃窦见巨大溃疡", so these sentences are always in.
  //
  // Contiguity rather than stitching is what keeps the excerpt honest about
  // what the report said between the hits, and keeps `text` a verbatim slice.
  const minIndex = Math.min(...relevantIndices);
  const maxIndex = Math.max(...relevantIndices);
  const coreLength = rangeLength(spans, minIndex, maxIndex);

  // The core already exceeds the budget: return it anyway. Coverage of the
  // sentences that decide the verdict beats the character cap, on the same
  // principle that keeps the anchor sentence whole - a context that is cheap
  // and wrong is worth less than none. This is the documented floor on the
  // effective cap: max(charBudget, coreLength).
  if (coreLength > budget) {
    return toWindow(fieldText, spans, minIndex, maxIndex);
  }

  // The core fits. Spend whatever is left on surrounding context, growing
  // outward one whole sentence at a time and alternating sides so a long
  // sentence on one side cannot monopolise the remainder. A side whose next
  // sentence does not fit is skipped for that round, so the other side can
  // still use the room.
  let lo = minIndex;
  let hi = maxIndex;
  let length = coreLength;
  let preferLeft = true;

  for (;;) {
    const leftLength = lo > 0 ? spanLength(spans[lo - 1]) : null;
    const rightLength = hi < spans.length - 1 ? spanLength(spans[hi + 1]) : null;
    if (leftLength === null && rightLength === null) {
      break;
    }

    const order: Array<'left' | 'right'> = preferLeft ? ['left', 'right'] : ['right', 'left'];
    let advanced = false;
    for (const side of order) {
      const candidate = side === 'left' ? leftLength : rightLength;
      if (candidate === null || length + candidate > budget) {
        continue;
      }
      if (side === 'left') {
        lo -= 1;
      } else {
        hi += 1;
      }
      length += candidate;
      advanced = true;
      break;
    }

    preferLeft = !preferLeft;
    if (!advanced) {
      break;
    }
  }

  return toWindow(fieldText, spans, lo, hi);
}

/** Character length of one sentence span. */
function spanLength(span: SentenceSpan): number {
  return span.end - span.start;
}

/** Length of the contiguous run of sentences from `lo` to `hi`, inclusive. */
function rangeLength(spans: readonly SentenceSpan[], lo: number, hi: number): number {
  return spans[hi].end - spans[lo].start;
}

function spanWindow(spans: readonly SentenceSpan[], lo: number, hi: number): SentenceSpan {
  return { start: spans[lo].start, end: spans[hi].end };
}

function toWindow(
  fieldText: string,
  spans: readonly SentenceSpan[],
  lo: number,
  hi: number,
): ContextWindow {
  const { start, end } = spanWindow(spans, lo, hi);
  return {
    text: fieldText.slice(start, end),
    start,
    end,
    isWholeField: start === 0 && end === fieldText.length,
  };
}
