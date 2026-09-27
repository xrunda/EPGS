import { VerifiedEvidence } from './types';
import { sha256Hex } from './hashing';

/**
 * Evidence verification (issue #87).
 *
 * WHY THIS GATE EXISTS: the model is asked to justify its verdict with an
 * excerpt copied from the context it was shown. Checking that the excerpt is
 * actually there is the difference between a judgement grounded in the report
 * and a fluent sentence that merely sounds grounded. A model that hallucinates
 * its justification has no reliable verdict either, so an unverifiable excerpt
 * makes the whole verdict unusable - and unusable means FAIL OPEN (the keyword
 * hit stands), never "filter it anyway".
 *
 * Verification happens entirely in memory. Only the excerpt's hash and the
 * offsets it was found at are returned; the excerpt itself is never stored,
 * per the owner's decision that report text does not get persisted by this
 * feature.
 *
 * WHITESPACE TOLERANCE: report bodies carry newlines, indentation and
 * full-width spaces, and a model reproducing an excerpt will normalize them.
 * An exact substring test would then reject honest evidence and fail open far
 * more often than the text warrants. So the context is also indexed in a
 * whitespace-collapsed form, with a map back to original offsets, and the
 * search runs against both. Offsets always refer to the ORIGINAL text.
 */

/** Shortest excerpt we will accept as a justification. */
const MIN_EVIDENCE_LENGTH = 2;

/**
 * Characters that wrap an excerpt in model output without being part of it.
 * Stripped before matching; a quote character is punctuation, not report text.
 */
const WRAPPER_CHARS = new Set(['"', "'", '“', '”', '‘', '’', '「', '」', '『', '』', '`', '…']);

function stripWrappers(value: string): string {
  let text = value.trim();
  let changed = true;
  while (changed && text.length > 0) {
    changed = false;
    const first = text[0];
    const last = text[text.length - 1];
    if (WRAPPER_CHARS.has(first)) {
      text = text.slice(1).trim();
      changed = true;
    } else if (WRAPPER_CHARS.has(last)) {
      text = text.slice(0, -1).trim();
      changed = true;
    }
  }
  return text;
}

/**
 * Build a whitespace-collapsed copy of `text` plus, for each character of the
 * copy, its offset in the original. Runs of whitespace become a single space
 * whose original offset is that of the run's first character, so a match
 * against the collapsed form maps back to a range in the original.
 */
function collapseWhitespace(text: string): { collapsed: string; offsets: number[] } {
  let collapsed = '';
  const offsets: number[] = [];
  let inWhitespaceRun = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inWhitespaceRun) {
        collapsed += ' ';
        offsets.push(i);
        inWhitespaceRun = true;
      }
      continue;
    }
    inWhitespaceRun = false;
    collapsed += ch;
    offsets.push(i);
  }

  return { collapsed, offsets };
}

/**
 * Locate `evidence` inside `contextText` and return its absolute offsets in
 * the underlying field text, or null when it cannot be found.
 *
 * @param evidence     The excerpt as returned by the model.
 * @param contextText  Exactly the text that was sent to the model.
 * @param contextStart Absolute offset of `contextText` within the field text,
 *                     so returned offsets are in field coordinates (the same
 *                     coordinates monitor_match.match_start uses, and the same
 *                     text an auditor can slice out of the report body).
 */
export function verifyEvidence(
  evidence: string | null | undefined,
  contextText: string,
  contextStart: number,
): VerifiedEvidence | null {
  if (typeof evidence !== 'string') {
    return null;
  }

  const cleaned = stripWrappers(evidence);
  if (cleaned.length < MIN_EVIDENCE_LENGTH || contextText.length === 0) {
    return null;
  }

  // An excerpt longer than the context cannot be a substring of it. Checked
  // before searching so an oversized claim is rejected as unverifiable rather
  // than accidentally matching a shorter fragment.
  if (cleaned.length > contextText.length) {
    return null;
  }

  const direct = contextText.indexOf(cleaned);
  if (direct !== -1) {
    return {
      hash: sha256Hex(cleaned),
      start: contextStart + direct,
      end: contextStart + direct + cleaned.length,
    };
  }

  // Retry with both sides whitespace-collapsed. Reject when the cleaned
  // excerpt itself contains no whitespace to collapse AND the direct search
  // already failed - that would just repeat the same failing search.
  const { collapsed, offsets } = collapseWhitespace(contextText);
  const collapsedEvidence = cleaned.replace(/\s+/g, ' ');

  const collapsedIndex = collapsed.indexOf(collapsedEvidence);
  if (collapsedIndex === -1) {
    return null;
  }

  const originalStart = offsets[collapsedIndex];
  const lastCollapsedIndex = collapsedIndex + collapsedEvidence.length - 1;
  // The matched range ends at the last character of the match, so its
  // exclusive end is that character's original offset + 1.
  const originalEnd = offsets[lastCollapsedIndex] + 1;

  return {
    hash: sha256Hex(cleaned),
    start: contextStart + originalStart,
    end: contextStart + originalEnd,
  };
}
