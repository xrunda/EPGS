/**
 * Sentence segmentation for context selection (issue #87).
 *
 * The issue requires the context sent to the model to include "the complete
 * sentence containing the hit" - not a fixed character radius. A radius is
 * what the existing display snippet uses (±20 chars), and it is exactly wrong
 * for judging meaning: "未见明显溃疡，胃窦见巨大溃疡" cut at ±20 chars around the
 * second occurrence can lose the negation that applies to it, and vice versa.
 * A sentence boundary is the smallest unit that carries the negation,
 * hedging and tense markers a judgement depends on.
 *
 * The spans returned are CONTIGUOUS and cover the whole input, so a run of
 * consecutive sentences is exactly `text.slice(spans[i].start, spans[j].end)`
 * - which is what lets context.ts guarantee that the context it hands out is a
 * verbatim slice with no injected markers, and therefore that evidence
 * verification and the stored offsets mean something.
 */

/** A half-open [start, end) range of one sentence within the source text. */
export interface SentenceSpan {
  /** Inclusive offset into the source text. */
  start: number;
  /** Exclusive offset into the source text. */
  end: number;
}

/**
 * Characters that END a sentence wherever they appear. Chinese report text
 * uses these as hard separators; `；`/`;` counts because endoscopy findings
 * are routinely written as semicolon-separated clauses, each of which is a
 * self-contained statement for the purposes of this judgement.
 */
const HARD_TERMINATORS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n', ' ', ' ']);

/**
 * Characters that end a sentence only when followed by whitespace or the end
 * of the text. A bare `.` is ambiguous in report text - it appears in
 * decimals ("1.5cm"), abbreviations and version strings - so requiring a
 * following separator keeps "1.5cm" from being split mid-measurement.
 */
const SOFT_TERMINATORS = new Set(['.']);

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Split text into contiguous sentence spans.
 *
 * Always returns at least one span for non-empty input, and always returns
 * `[]` for empty input. Adjacent spans share a boundary (span[i].end ===
 * span[i+1].start), and the first span starts at 0 while the last ends at
 * `text.length`.
 *
 * Whitespace between sentences belongs to the sentence that precedes it, so no
 * character is dropped and no span is empty unless the input is.
 */
export function splitSentences(text: string): SentenceSpan[] {
  if (text.length === 0) {
    return [];
  }

  const spans: SentenceSpan[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const isHard = HARD_TERMINATORS.has(ch);
    const isSoft = SOFT_TERMINATORS.has(ch) && (i + 1 >= text.length || isWhitespace(text[i + 1]));

    if (!isHard && !isSoft) {
      continue;
    }

    // Absorb everything up to the next non-whitespace character into this
    // sentence. This covers a CRLF pair as a unit, and - more importantly -
    // guarantees no whitespace-only span can appear between two sentences:
    // a blank line in a report would otherwise become its own "sentence",
    // and the window builder treats every span as a candidate for inclusion.
    let end = i + 1;
    while (end < text.length && isWhitespace(text[end])) {
      end += 1;
    }

    spans.push({ start, end });
    start = end;
    // Skip the loop's own increment past what we just consumed.
    i = end - 1;
  }

  if (start < text.length) {
    spans.push({ start, end: text.length });
  }

  return spans;
}

/**
 * Index of the sentence containing `offset`.
 *
 * An offset sitting exactly on a boundary belongs to the sentence that STARTS
 * there (the later one), except at the very end of the text where there is no
 * later sentence. This matters for a hit that begins immediately after a
 * terminator: attributing it to the previous sentence would drag the wrong
 * clause into the window.
 *
 * Returns -1 only for empty text. An out-of-range offset is clamped to the
 * nearest span rather than throwing - context.ts has already validated the
 * anchor, and a clamp is the fail-safe direction here.
 */
export function sentenceIndexAt(spans: readonly SentenceSpan[], offset: number): number {
  if (spans.length === 0) {
    return -1;
  }
  if (offset <= spans[0].start) {
    return 0;
  }
  if (offset >= spans[spans.length - 1].end) {
    return spans.length - 1;
  }

  // Binary search for the last span whose start is <= offset.
  let low = 0;
  let high = spans.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (spans[mid].start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
