import { AttentionLevel, MatchField, MonitorLevel, ReportAiField } from '@prisma/client';

/**
 * Issue #103: where the keyword path and the report-level path found something in
 * the SAME place but asked for DIFFERENT attention levels.
 *
 * WHY THIS EXISTS. Before this, such a pair rendered as two ordinary rows in one
 * merged list - a red one and a yellow one, side by side - which a doctor reads
 * as "this report has two things worth reading". It is actually one thing with a
 * configuration disagreement behind it, and someone has to settle which rule
 * should win. Nothing in the product said so, and nothing recorded that it had
 * happened.
 *
 * WHAT IT IS NOT. It reports a disagreement, never a winner: neither side is
 * called wrong, and the levels themselves are not touched. It also never runs a
 * model - the whole test is arithmetic on offsets that are already stored.
 *
 * Kept pure and dependency-free (the monitor-time / data-scope pattern) so the
 * rule can be unit-tested exhaustively. It is the ONLY implementation of the
 * rule: the doctor's drawer and the admin's todo list both call it, so the two
 * can never disagree about what counts as a conflict.
 */

/** Which monitor_record column an offset is into. */
type ReportColumn = 'examItem' | 'reportContent' | 'diagnosis';

/**
 * The keyword side's field -> column map.
 *
 * DELIBERATELY PARTIAL, and the omission is the point. `matchedField` on the
 * stored row is documented in shared-types as possibly being a broad
 * `REPORT_TEXT`/`OTHER` "both columns" pseudo-field, but it never actually is:
 * `resolveFieldsForRule` (packages/matching-engine/src/matcher.ts) expands a
 * rule's configured field into concrete columns and persists the column the text
 * actually came from. `STUDY_DESCRIPTION` is a documented no-op that no rule can
 * match today.
 *
 * So a value with no entry here is one whose offsets do not address a single
 * knowable column. Those are skipped rather than guessed at: this notice tells a
 * doctor two things are the same thing, and being wrong about that is worse than
 * saying nothing.
 */
const HIT_COLUMN: Partial<Record<MatchField, ReportColumn>> = {
  FINDINGS: 'reportContent',
  IMPRESSION: 'diagnosis',
};

/**
 * The AI side's field -> column map. Total, because `ReportAiField` has exactly
 * the three columns that have a text source. `EXAM_ITEM` is included so the map
 * is exhaustive, not because it can ever pair: a keyword hit is never in the exam
 * item, so no hit can share that column.
 */
const FINDING_COLUMN: Record<ReportAiField, ReportColumn> = {
  EXAM_ITEM: 'examItem',
  FINDINGS: 'reportContent',
  IMPRESSION: 'diagnosis',
};

/** One effective keyword hit (already filtered to `semanticFiltered === false`). */
export interface ConflictHitInput {
  /**
   * Stable across rule versions, so a todo built from this does not resurrect
   * when someone edits the rule's wording. Not part of the wire DTO.
   */
  ruleGroupId: string;
  keyword: string;
  level: MonitorLevel;
  matchedField: MatchField;
  /** UTF-16 offsets into the original column text; NULL for rows written before #87. */
  matchStart: number | null;
  matchEnd: number | null;
}

/** One verified excerpt behind an AI finding. */
export interface ConflictEvidenceInput {
  field: ReportAiField;
  /** The stored offsets, used for the overlap test. */
  start: number;
  end: number;
  /**
   * The excerpt recomputed from the CURRENT report text, or null when it cannot
   * be recomputed (offsets out of range, or the text no longer matches the stored
   * hash). Only the fallback path below reads it.
   *
   * It is passed IN rather than reconstructed here so that reconstruction has
   * exactly one implementation (report-ai.mapper.ts) and this module stays free
   * of the report text entirely.
   */
  text: string | null;
}

/** One finding of the current report version. */
export interface ConflictFindingInput {
  /** Stable across semantic versions - see ConflictHitInput.ruleGroupId. */
  semanticGroupId: string;
  semanticName: string;
  attentionLevel: AttentionLevel;
  evidence: ConflictEvidenceInput[];
}

export interface LevelConflict {
  ruleGroupId: string;
  semanticGroupId: string;
  keyword: string;
  keywordLevel: MonitorLevel;
  semanticName: string;
  semanticLevel: AttentionLevel;
  /** The column both sides landed in. Only FINDINGS / IMPRESSION can occur. */
  field: MatchField;
}

export interface FindLevelConflictsInput {
  /** Effective hits only. A hit the AI ruled out is not a disagreement - it is #87's story. */
  hits: readonly ConflictHitInput[];
  findings: readonly ConflictFindingInput[];
}

/**
 * The conflicts in one record.
 *
 * A pair conflicts when ALL of these hold:
 *
 *  1. **Same column.** Both sides' offsets address one report column, and it is
 *     the same one. A keyword in the findings and a finding in the impression are
 *     two different places even if the same words appear in both, so they never
 *     pair. A field value with no column (see HIT_COLUMN) never pairs.
 *  2. **Same place.** Either the two ranges intersect, or - when the keyword
 *     side has no offsets at all - the excerpt the AI verified contains the
 *     keyword. The second form is not optional: `matchStart` is NULL for rows
 *     written before #87, and intersecting-only would silently drop every one of
 *     them from a feature whose whole value is not staying silent.
 *  3. **Different levels.** Equal is agreement, and agreement gets no notice.
 *
 * Ranges are half-open, so touching (`hit.end === evidence.start`) is NOT an
 * overlap. "The keyword ends exactly where the quote begins" is adjacency, not
 * the same place, and treating it as one would report conflicts between two
 * neighbouring findings.
 *
 * The fallback needs a recomputed excerpt; when there is none (a stale or
 * unreadable offset) the pair is dropped rather than assumed. Under-reporting is
 * the safe direction here - a crossed-out sentence in the drawer costs a doctor
 * more than a missed notice costs an admin.
 */
export function findLevelConflicts(input: FindLevelConflictsInput): LevelConflict[] {
  const conflicts: LevelConflict[] = [];
  const seen = new Set<string>();

  for (const hit of input.hits) {
    const hitColumn = HIT_COLUMN[hit.matchedField];
    if (hitColumn === undefined) continue;

    for (const finding of input.findings) {
      if (sameLevel(hit.level, finding.attentionLevel)) continue;

      for (const evidence of finding.evidence) {
        if (FINDING_COLUMN[evidence.field] !== hitColumn) continue;
        if (!samePlace(hit, evidence)) continue;

        // Deduplicated on the FULL identity, group ids included: two different
        // rules that share a keyword and a level are two configuration problems
        // for the admin, even though a doctor reads them as one sentence. The
        // doctor's mapper collapses them; this list must not.
        const identity = [
          hit.ruleGroupId,
          hit.keyword,
          hit.level,
          finding.semanticGroupId,
          finding.semanticName,
          finding.attentionLevel,
          hit.matchedField,
        ].join('\u0000');
        if (seen.has(identity)) continue;
        seen.add(identity);

        conflicts.push({
          ruleGroupId: hit.ruleGroupId,
          semanticGroupId: finding.semanticGroupId,
          keyword: hit.keyword,
          keywordLevel: hit.level,
          semanticName: finding.semanticName,
          semanticLevel: finding.attentionLevel,
          field: hit.matchedField,
        });
      }
    }
  }

  return conflicts.sort(compareConflicts);
}

/**
 * `MonitorLevel` and `AttentionLevel` are separate enums (the AI side has no
 * UNCLASSIFIED by design), so this compares values rather than ranking them.
 * Nothing here needs to know which level is "worse" - the question is only
 * whether the two sides said the same thing.
 */
function sameLevel(keywordLevel: MonitorLevel, semanticLevel: AttentionLevel): boolean {
  return (keywordLevel as string) === (semanticLevel as string);
}

/** Overlap, or - when the keyword side has no offsets - textual containment. */
function samePlace(hit: ConflictHitInput, evidence: ConflictEvidenceInput): boolean {
  const { matchStart: start, matchEnd: end } = hit;

  if (start === null || end === null) {
    return evidence.text !== null && evidence.text.includes(hit.keyword);
  }

  // The interval test is pure arithmetic: two half-open ranges against the same
  // text either intersect or they do not, and this module never needs to know
  // how long that text is. A range that cannot be a range (non-integer, negative,
  // or empty) is refused rather than trusted - the same defensiveness
  // reconstructEvidence applies to the evidence side.
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (!Number.isInteger(evidence.start) || !Number.isInteger(evidence.end)) return false;
  if (start < 0 || start >= end) return false;

  return start < evidence.end && evidence.start < end;
}

/**
 * Stable output order (column, then keyword, then finding name) so the wire is
 * byte-identical between two reads of unchanged data and tests can assert on it.
 *
 * Code-unit comparison, deliberately NOT `localeCompare`: the hospital's names are
 * Chinese, and a locale collation would order them by pinyin - which depends on
 * the ICU data the process happens to be built with. The order a doctor sees
 * should not change because a runtime was upgraded, and a test that asserts it
 * should be asserting this rule rather than the host.
 */
function compareConflicts(a: LevelConflict, b: LevelConflict): number {
  return (
    compareText(a.field, b.field) ||
    compareText(a.keyword, b.keyword) ||
    compareText(a.semanticName, b.semanticName)
  );
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
