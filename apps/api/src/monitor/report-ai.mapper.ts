import { createHash } from 'node:crypto';
import { AttentionLevel, ReportAiField, SemanticConfidence } from '@prisma/client';
import {
  ATTENTION_LEVELS_DTO,
  MonitorAiEvidenceDto,
  MonitorAiSemanticDto,
  MonitorAttentionSourceDto,
} from '@epgs/shared-types';

/**
 * Issue #88 (PR-B): turns the report-level AI audit rows into the doctor-facing
 * explanation shown in the workbench.
 *
 * Kept as pure functions in their own module (the monitor-time / data-scope
 * pattern) because two of the rules here are safety rules, not formatting:
 *
 *  1. WHICH attempt's findings may be shown. The audit tables are append-only,
 *     so a report whose text was replaced still has the previous attempt's rows
 *     pointing at offsets into the OLD text. Showing those would put a finding
 *     on screen that the record's own `monitorLevel` and `attentionSource` - both
 *     driven by the now-NULL `aiAttentionLevel` - contradict. The guards below
 *     keep the drawer and the level moving together.
 *  2. Whether an excerpt may be shown at all. The excerpt is NOT stored (only
 *     its hash and its offsets), so it is recomputed from the CURRENT report
 *     text on every read, and is dropped the moment those offsets stop landing
 *     on the text they were computed against.
 *
 * Nothing here reads or returns an audit field: no hash, model, version,
 * latency or error crosses into the DTOs (docs/api/monitor-api.md). The hash is
 * used only as an internal check.
 */

/** One `monitor_report_ai_evidence` row, as DETAIL_INCLUDE selects it. */
export interface ReportAiEvidenceRow {
  ordinal: number;
  field: ReportAiField;
  evidenceHash: string;
  evidenceStart: number;
  evidenceEnd: number;
}

/** One `monitor_report_ai_match` row + its evidence. */
export interface ReportAiMatchRow {
  semanticId: string;
  semanticVersion: number;
  semanticName: string;
  attentionLevel: AttentionLevel;
  confidence: SemanticConfidence;
  reason: string;
  ordinal: number;
  evidence: ReportAiEvidenceRow[];
}

/** One `monitor_report_ai` attempt (outcome OK only - see selectCurrentAttempt). */
export interface ReportAiAttemptRow {
  reportVersion: number;
  createdAt: Date;
  matches: ReportAiMatchRow[];
}

/**
 * The monitor_record columns the AI state lives on, plus the three text columns
 * an evidence row's offsets can point into. Declared separately from
 * MonitorExamDetailRow so the pure functions in this module can be unit-tested
 * without building a whole record.
 */
export interface ReportAiRecordRow {
  reportVersion: number;
  aiAttentionLevel: AttentionLevel | null;
  aiResolvedAt: Date | null;
  examItem: string | null;
  reportContent: string | null;
  diagnosis: string | null;
}

/**
 * Where the record's current attention level came from.
 *
 * `BOTH` means "both paths found something a doctor should read", NOT "the AI
 * raised the level": a keyword RED with an AI YELLOW is still `BOTH`. Comparing
 * the two levels would answer a different question ("why is it at THIS level")
 * and would hide the AI's finding from the badge exactly when the keyword path
 * already covers the record - which is when the extra context matters most.
 */
export function toAttentionSource(
  hasKeywordFinding: boolean,
  aiAttentionLevel: AttentionLevel | null,
): MonitorAttentionSourceDto {
  const aiFound = aiAttentionLevel !== null;
  if (hasKeywordFinding) return aiFound ? 'BOTH' : 'RULE';
  return aiFound ? 'AI_REPORT' : 'NONE';
}

/**
 * True when the AI has judged THIS version of the report, whatever it found.
 * This is what lets the drawer say "the AI read it and found nothing" instead of
 * leaving the doctor unable to tell that apart from "the AI never ran".
 */
export function toAiJudged(
  attempts: readonly ReportAiAttemptRow[],
  record: ReportAiRecordRow,
): boolean {
  return selectCurrentAttempt(attempts, record) !== null;
}

/**
 * The findings to show for this record, or [] when none may be shown.
 *
 * Empty is a normal answer, not an error: no attempt, an attempt against
 * different text, or an attempt whose verdict is not currently in force.
 */
export function toAiSemantics(
  attempts: readonly ReportAiAttemptRow[],
  record: ReportAiRecordRow,
): MonitorAiSemanticDto[] {
  const attempt = selectCurrentAttempt(attempts, record);
  if (attempt === null) return [];

  // The load-bearing guard. `aiAttentionLevel` is the SAME input the level
  // recomputation reads (record-level.ts), so gating on it makes it impossible
  // for the drawer to show a finding while the level says the AI found nothing.
  // This is what closes the window between a re-sync replacing the report text
  // (which nulls the AI state and leaves the old append-only rows behind) and
  // the re-classification landing: the stale rows stay invisible throughout.
  if (record.aiAttentionLevel === null) return [];

  return [...attempt.matches].sort(byAttentionThenOrdinal).map((match) => ({
    semanticId: match.semanticId,
    semanticVersion: match.semanticVersion,
    name: match.semanticName,
    attentionLevel: match.attentionLevel,
    confidence: match.confidence,
    reason: match.reason,
    evidence: [...match.evidence]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => reconstructEvidence(row, record))
      .filter((excerpt): excerpt is MonitorAiEvidenceDto => excerpt !== null),
  }));
}

/**
 * The one attempt whose findings describe the report as it is now.
 *
 * Callers pass OK-outcome attempts ordered newest first (createdAt desc, id
 * desc - see DETAIL_INCLUDE). An ERROR attempt has no verdict and no matches, so
 * it is filtered in SQL rather than here.
 *
 * An attempt against a DIFFERENT report version is never substituted by an older
 * one: a superseded verdict is stale, not an alternative. Today `reportVersion`
 * is always 1 (resolveReportVersion), so this guard is vacuous in practice - it
 * is kept because it is the contract anchor schema.prisma documents, and because
 * "vacuous today" is exactly what changes without anyone noticing.
 */
function selectCurrentAttempt(
  attempts: readonly ReportAiAttemptRow[],
  record: ReportAiRecordRow,
): ReportAiAttemptRow | null {
  const current = attempts.filter((attempt) => attempt.reportVersion === record.reportVersion);
  if (current.length === 0) return null;

  // Prefer the attempt that actually produced the current AI state. Normally the
  // newest one IS that attempt, but a concurrent attempt that lost the
  // `aiResolvedAt: null` guard still writes its audit row (the trail is
  // one-row-per-attempt) without touching the record - so "newest" and "the one
  // in force" can differ. classify.store.ts writes the same `now` into the
  // attempt's createdAt and the record's aiResolvedAt, so equality identifies
  // the winner exactly. Falls back to newest when nothing matches (an older
  // record predating that pairing, or a hand-seeded fixture).
  if (record.aiResolvedAt !== null) {
    const resolvedAt = record.aiResolvedAt.getTime();
    const winner = current.find((attempt) => attempt.createdAt.getTime() === resolvedAt);
    if (winner) return winner;
  }
  return current[0];
}

/**
 * Most attention-worthy first (RED -> YELLOW -> GREEN), then the model's own
 * response order. The doctor should read the finding that decided the level
 * first, which is also the order the level was computed under; `ordinal` alone
 * would lead with whatever the model happened to emit first.
 */
function byAttentionThenOrdinal(a: ReportAiMatchRow, b: ReportAiMatchRow): number {
  const byLevel = levelRank(a.attentionLevel) - levelRank(b.attentionLevel);
  return byLevel !== 0 ? byLevel : a.ordinal - b.ordinal;
}

/** ATTENTION_LEVELS_DTO's declared order IS the attention priority. */
function levelRank(level: AttentionLevel): number {
  const index = ATTENTION_LEVELS_DTO.indexOf(level);
  return index === -1 ? ATTENTION_LEVELS_DTO.length : index;
}

/** Which monitor_record column an evidence row's offsets are into. */
const EVIDENCE_COLUMN: Record<ReportAiField, 'examItem' | 'reportContent' | 'diagnosis'> = {
  EXAM_ITEM: 'examItem',
  FINDINGS: 'reportContent',
  IMPRESSION: 'diagnosis',
};

/**
 * Recomputes one excerpt from its stored offsets against the CURRENT report
 * text, or null when it cannot be shown.
 *
 * Null is the answer for every failure - text since cleared, offsets out of
 * range, offsets that no longer land on the text they were computed against.
 * The caller drops the excerpt and KEEPS the finding: `evidence: []` is an
 * unambiguous "we cannot show you the quote", whereas dropping the finding would
 * leave the drawer unable to explain a level that still counts it. No branch
 * throws, so a stale or corrupt row can never turn a read into a 500.
 *
 * The hash check is what makes this more than a bounds check. `evidence_hash` is
 * sha256 of the string the MODEL returned (after wrapper-stripping), and the
 * offsets point at the report text; the two are identical only on the direct
 * match. verifyEvidence's retry locates a whitespace-collapsed excerpt in the
 * original text, so there the stored hash is over the collapsed form while the
 * slice is the original - which is why the collapsed comparison exists. It
 * deliberately widens acceptance to whitespace variants ONLY (the same class the
 * verifier itself tolerates) and can never accept different text.
 */
function reconstructEvidence(
  row: ReportAiEvidenceRow,
  record: ReportAiRecordRow,
): MonitorAiEvidenceDto | null {
  const text = record[EVIDENCE_COLUMN[row.field]];
  if (text === null) return null;

  const { evidenceStart: start, evidenceEnd: end } = row;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= end || end > text.length) return null;

  const excerpt = text.slice(start, end);
  if (excerpt.trim().length === 0) return null;

  const collapsed = excerpt.replace(/\s+/g, ' ').trim();
  if (sha256Hex(excerpt) !== row.evidenceHash && sha256Hex(collapsed) !== row.evidenceHash) {
    return null;
  }

  return { field: row.field, text: excerpt };
}

/**
 * sha256 of a UTF-8 string, lowercase hex.
 *
 * Local rather than imported from @epgs/ai-semantic: apps/api must not depend on
 * that package (docs/ai-semantic-monitor-design.md), and this is three lines of
 * node:crypto, not a second implementation of the verifier.
 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
