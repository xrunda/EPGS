/**
 * Text normalization for MATCH COMPARISON ONLY.
 *
 * Per issue #5: "文本标准化不得改变可审计原文；保留原文定位（start/end
 * 字符偏移）". Every normalization here is a strict 1:1, index-preserving
 * character substitution (never insertion/deletion/reordering), so a
 * match's start/end offset found in normalized text is always valid to
 * slice out of the *original* text unchanged. This module never mutates
 * or returns the original text for storage/display - callers must keep
 * the original string as the source of truth for context snippets.
 */

/**
 * A handful of CJK punctuation marks (U+3000-303F block) that have an
 * obvious ASCII equivalent but do NOT sit in the fixed-offset FF01-FF5E
 * "fullwidth forms" block, so they need an explicit 1-to-1 mapping instead
 * of the arithmetic shift below. Only marks with an unambiguous single-char
 * ASCII counterpart are included, to keep this a lossless substitution.
 */
const CJK_PUNCTUATION_MAP: Record<number, string> = {
  0x3000: ' ', // 全角空格 -> space
  0x3001: ',', // 、 (顿号) -> comma
  0x3002: '.', // 。 (句号) -> period
  0x300a: '<', // 《
  0x300b: '>', // 》
};

/**
 * Full-width (SBC) -> half-width (ASCII) mapping for the common
 * full-width punctuation/alphanumeric block (U+FF01-U+FF5E), plus a small
 * explicit map for CJK punctuation (full-width space, 、。《》) that falls
 * outside that block. This is a 1-to-1 character substitution: it never
 * changes string length.
 */
function toHalfWidthChar(ch: string): string {
  const code = ch.codePointAt(0)!;
  const mapped = CJK_PUNCTUATION_MAP[code];
  if (mapped !== undefined) {
    return mapped;
  }
  if (code >= 0xff01 && code <= 0xff5e) {
    // Fixed offset between full-width and ASCII block.
    return String.fromCodePoint(code - 0xfee0);
  }
  return ch;
}

/**
 * Normalizes text for matching comparison only:
 *  - full-width punctuation/alphanumerics -> half-width equivalents
 *  - (case folding is handled separately per-rule in matcher.ts, since
 *    case sensitivity is a per-rule flag, not a global normalization)
 *
 * GUARANTEE: output has exactly the same length as input, and
 * output[i] is the normalized form of input[i] for every index i. This
 * lets matcher.ts search the normalized string and use the found indices
 * directly as offsets into the original string.
 */
export function normalizeForMatch(text: string): string {
  // Use Array.from is unnecessary and would break the 1:1 index guarantee
  // for surrogate-pair characters (e.g. some CJK extension chars) - we
  // deliberately iterate by UTF-16 code unit (plain string indexing) to
  // keep normalized[i] aligned with original[i] for every i, matching how
  // MatchInput offsets (and Prisma varchar/text columns) are indexed.
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += toHalfWidthChar(text[i]);
  }
  return out;
}

/** Case-folds text for case-insensitive comparison. Length-preserving for the ASCII range this engine cares about (Latin letters like "ca"/"CA"); not guaranteed length-preserving for exotic Unicode casing edge cases, but those never occur in the ASCII keyword scenarios this issue targets. */
export function toComparisonCase(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : text.toLowerCase();
}
