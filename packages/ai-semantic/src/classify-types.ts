import type { SemanticConfidence, SemanticErrorCode, SemanticTask } from './types';

/**
 * Public types for the Classify Report task (issue #88).
 *
 * WHAT THIS TASK IS, and how it differs from Validate Match (#87):
 *
 *   #87 takes ONE keyword hit and asks "what does this sentence mean?". Its
 *   output can REMOVE a hit from the attention result.
 *
 *   #88 takes a WHOLE report plus the hospital's configured attention semantics
 *   and asks "which of these meanings does this report express?". Its output can
 *   only ever ADD findings. There is no `filtered`, no disposition, and no code
 *   path in this task that can lower a level or suppress anything.
 *
 * THE SAME DIVISION OF RESPONSIBILITY STILL HOLDS - the model INTERPRETS, the
 * CODE DECIDES:
 *
 *   The model says which configured semantics a report matches and quotes the
 *   text that shows it. Every match must name a `semantic_id` the hospital
 *   configured; the model never sees, invents, or assigns an attention level.
 *
 *   The CODE then resolves each `semantic_id` against the configuration
 *   snapshot that was actually sent, reads that entry's configured
 *   `attentionLevel`, and computes the report's level as the MAXIMUM of those.
 *   The model's own `attention_level` field is recorded for audit and
 *   cross-checked for coherence - if it disagrees with what the code computed,
 *   the whole attempt is rejected (INCOHERENT_LEVEL) and no match is written.
 *   So a model that says "RED" cannot make a report red, and a model that says
 *   "NONE" cannot make one quiet. This mirrors exactly how #87 records the
 *   model's `matched` flag without letting the disposition matrix read it.
 *
 * FAILURE DIRECTION IS INVERTED RELATIVE TO #87, and it matters. #87 fails OPEN
 * by keeping the keyword hit; #88 "fails open" by producing NO AI finding at
 * all. Every failure below leaves the keyword path, #87's judgement, the sync
 * job and the notification flow exactly as they would have been.
 *
 * Enum-shaped fields are redeclared as plain string unions rather than imported
 * from `@prisma/client` (same reasoning as types.ts / matching-engine). Names and
 * values are kept identical to apps/api/prisma/schema.prisma (`AttentionLevel`,
 * `ReportAiField`) so adapters pass values straight through.
 */

/**
 * The colour a hospital assigns to one attention semantic. Mirrors Prisma enum
 * `AttentionLevel`.
 *
 * Deliberately has no NONE member: an entry always carries a colour. "NONE" is
 * a property of a REPORT (nothing matched it), which is why it appears only on
 * the wire union below and not here.
 */
export type AttentionLevel = 'RED' | 'YELLOW' | 'GREEN';

/** Runtime list of every AttentionLevel, for strict wire-value validation. */
export const ATTENTION_LEVELS: readonly AttentionLevel[] = ['RED', 'YELLOW', 'GREEN'];

/**
 * The `attention_level` values the MODEL may emit (issue #88 §7). Extends the
 * configured levels with NONE, which means "no configured semantic applies".
 *
 * NONE is never stored in an AttentionLevel column: a report whose AI
 * classification matched nothing stores SQL NULL, and the audit row records
 * outcome OK with match_count 0.
 */
export type AttentionLevelOrNone = AttentionLevel | 'NONE';

/** Runtime list of every wire attention level, for strict validation. */
export const ATTENTION_LEVELS_OR_NONE: readonly AttentionLevelOrNone[] = [
  'RED',
  'YELLOW',
  'GREEN',
  'NONE',
];

/**
 * Report fields sent to the model, and therefore the only fields an evidence
 * offset can point into. Mirrors Prisma enum `ReportAiField`.
 *
 * Each maps to exactly one monitor_record column:
 *   EXAM_ITEM  -> exam_item       (检查项目)
 *   FINDINGS   -> report_content  (报告正文 / 检查所见)
 *   IMPRESSION -> diagnosis       (诊断意见)
 */
export type ReportAiField = 'EXAM_ITEM' | 'FINDINGS' | 'IMPRESSION';

/** Runtime list of every ReportAiField. */
export const REPORT_AI_FIELDS: readonly ReportAiField[] = ['EXAM_ITEM', 'FINDINGS', 'IMPRESSION'];

/**
 * One hospital-configured attention semantic, snapshotted at call time.
 *
 * `id` is the id of a SPECIFIC VERSION ROW, not of a logical semantic - that is
 * what makes a match traceable to the exact text in force when it was judged
 * (see AttentionSemantic in schema.prisma).
 */
export interface AttentionSemanticSnapshot {
  /** AttentionSemantic.id - the exact version row. */
  id: string;
  /** AttentionSemantic.version, snapshotted for the audit trail. */
  version: number;
  /** The configured colour. Chosen by the hospital; the model never sets it. */
  attentionLevel: AttentionLevel;
  /** Short display name, e.g. "高度疑似恶性病变". */
  name: string;
  /** The doctor's natural-language statement of the meaning to watch for. */
  description: string;
}

/**
 * Everything the task needs to classify one report.
 *
 * Assembled by the caller's DB adapter from a MonitorRecord plus the currently
 * ENABLED AttentionSemantic rows. Patient identity, department, bed number and
 * exam time are deliberately absent: they do not affect whether a report
 * expresses a meaning, and sending them would put patient identifiers on the
 * wire for nothing.
 *
 * The keyword rules and any existing keyword hits are deliberately absent too.
 * If the model could see what already matched, it could not independently find
 * what the keyword path missed - which is the entire point of this task.
 */
export interface ClassifyReportInput {
  /** 检查项目 (monitor_record.exam_item). Optional; omitted from the prompt when empty. */
  examItem?: string | null;
  /** 报告正文 / 检查所见 (monitor_record.report_content). */
  reportContent?: string | null;
  /** 诊断意见 (monitor_record.diagnosis). */
  diagnosis?: string | null;
  /**
   * The enabled attention semantics, in the order they will be presented. The
   * caller must pass them in a DETERMINISTIC order (by id): the same
   * configuration presented differently would otherwise hash differently, which
   * would make `configHash` meaningless.
   */
  semantics: readonly AttentionSemanticSnapshot[];
}

/**
 * One report field as it will be presented to the model: labelled with its
 * field, carrying the field's text verbatim.
 *
 * `text` is ALWAYS the untrimmed monitor_record column value, so an evidence
 * offset computed against it is directly usable against that column. Empty
 * fields are omitted entirely rather than sent as a blank block - see
 * deriveReportSections.
 */
export interface ReportSection {
  field: ReportAiField;
  text: string;
}

/**
 * The order report fields are presented in the prompt, and therefore the order
 * evidence is searched in. Fixed so the prompt, the audit trail and the evidence
 * resolution all agree without a caller having to remember.
 */
export const REPORT_SECTION_ORDER: readonly ReportAiField[] = [
  'EXAM_ITEM',
  'FINDINGS',
  'IMPRESSION',
];

/** One semantic match as the model returned it, before any verification. */
export interface ClassifyReportMatch {
  /** The configured semantic the model says applies. Unverified at this point. */
  semanticId: string;
  /** The model's short Chinese explanation. Bounded (see MAX_REASON_LENGTH). */
  reason: string;
  confidence: SemanticConfidence;
  /** Excerpts copied from the report text. Unverified at this point. */
  evidence: string[];
}

/** The model's reply after strict parsing, before resolution/verification. */
export interface ClassifyReportVerdict {
  /** What the model claims the report's level is. Audited, never trusted. */
  attentionLevel: AttentionLevelOrNone;
  matches: ClassifyReportMatch[];
}

/** Where one verified evidence excerpt sits, and in which field. */
export interface VerifiedClassifyEvidence {
  /** The report field the excerpt was located in. */
  field: ReportAiField;
  /** sha256 of the excerpt as the model returned it. Never the excerpt itself. */
  hash: string;
  /** Inclusive start offset into that field's text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** One match after the model's claim was resolved against the configuration. */
export interface VerifiedClassifyMatch {
  /** AttentionSemantic.id of the exact version row that matched. */
  semanticId: string;
  /** Snapshot of that row at call time. */
  semanticVersion: number;
  semanticName: string;
  /**
   * The CONFIGURED colour of that entry. This - not the model's opinion - is
   * what the report's final level is computed from.
   */
  attentionLevel: AttentionLevel;
  confidence: SemanticConfidence;
  reason: string;
  /** Position in the model's response. */
  ordinal: number;
  /** At least one, always: a match with no verified evidence is not a match. */
  evidence: VerifiedClassifyEvidence[];
}

/** Every failure the Classify Report task can report. */
export type ClassifyReportErrorCode =
  // Transport / parsing failures, shared with #87 (see SemanticErrorCode).
  | SemanticErrorCode
  // The model named a semantic_id that was not in the configuration it was sent.
  // Issue #88 §9: this fails the whole attempt - the model is answering about
  // something the hospital did not configure, so none of its output is
  // trustworthy.
  | 'UNKNOWN_SEMANTIC'
  // The model's own attention_level disagrees with the maximum configured level
  // across its verified matches. See the module comment: this is what stops the
  // model from setting a level.
  | 'INCOHERENT_LEVEL'
  // None of the three report fields had any text. No call is made.
  | 'EMPTY_INPUT'
  // The hospital has no enabled attention semantics, so there is nothing to
  // match against. Not a failure so much as a precondition - the worker checks
  // this before claiming and never writes an audit row for it, so the backlog is
  // classified as soon as the hospital configures its first semantic rather than
  // being drained into "resolved" while unconfigured.
  | 'NO_SEMANTICS'
  // The assembled report text exceeded SEMANTIC_REPORT_MAX_CHARS. Skipped rather
  // than truncated: a verdict about half a report is not explainable, and the
  // half that was cut could be the half that mattered.
  | 'REPORT_TOO_LONG';

/** One attempt's full result. Pure data - the caller persists it. */
export interface ClassifyReportResult {
  /** Whether the CALL produced a usable, fully verified result. */
  outcome: 'OK' | 'ERROR';
  /** Always CLASSIFY_REPORT. */
  task: SemanticTask;
  /** Prompt/contract version that produced this attempt. */
  taskVersion: string;
  /** Model identifier as configured. */
  model: string;
  /** Model version/revision as reported by the gateway, when it reports one. */
  modelVersion: string | null;
  /** Wall-clock duration of the model call; null when no call was made. */
  latencyMs: number | null;
  /** Machine-readable failure code; null when outcome is OK. */
  error: ClassifyReportErrorCode | null;

  /**
   * The report's level, COMPUTED BY CODE as the maximum configured level across
   * `matches`. Null when outcome is ERROR, and also when an OK attempt verified
   * zero matches - a genuine "NONE" (issue #88 §8). The two are told apart by
   * `outcome` and `matches.length`.
   */
  attentionLevel: AttentionLevel | null;

  /**
   * What the MODEL claimed the level was, recorded for audit and to measure
   * drift. Null when no call was made. Never read by any level computation.
   */
  modelAttentionLevel: AttentionLevelOrNone | null;

  /** Every verified match - ALL of them, never only the highest (issue #88 §8). */
  matches: VerifiedClassifyMatch[];
  /** How many enabled semantics were sent, for the audit row. */
  semanticCount: number;

  /** sha256 of the canonical task input (task + version + model + hashes). */
  inputHash: string;
  /** sha256 of the canonical report snapshot alone. */
  reportHash: string;
  /** sha256 of the canonical attention-semantic snapshot alone. */
  configHash: string;
}

/**
 * Task/prompt contract version, stored on every audit row.
 *
 * Bump this whenever the prompt text or the output schema changes: it is how a
 * historical classification stays attributable to the exact contract that
 * produced it. Changing the prompt WITHOUT bumping this makes old and new
 * judgements indistinguishable in the audit trail.
 */
export const CLASSIFY_REPORT_PROMPT_VERSION = 'classify-report/1';

/**
 * Hard bound on a persisted match `reason`, matching the column's varchar(300).
 * Same value as #87's MAX_REASON_LENGTH, kept as its own constant so the two
 * tasks can diverge without one silently changing the other's storage bound.
 */
export const MAX_CLASSIFY_REASON_LENGTH = 300;

/**
 * Hard bound on the description a hospital may enter for one attention
 * semantic (issue #88 §6: entries stay short and express ONE intent, so a
 * description that needs more room is a sign it should be split into several).
 *
 * This package DECLARES the bound; it does not enforce it - the engine receives
 * an already-validated snapshot. Enforcement lives at the write path, in the
 * AttentionSemantic DTOs, which read the same numbers from @epgs/shared-types
 * (ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH there). The two are kept equal by
 * review, the same way MAX_REASON_LENGTH is kept equal to its column width; a
 * divergence would let a description through that the prompt was never sized
 * for.
 */
export const ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH = 300;

/**
 * Hard bound on the name a hospital may enter for one attention semantic.
 * Counterpart: ATTENTION_SEMANTIC_NAME_MAX_LENGTH in @epgs/shared-types.
 */
export const ATTENTION_SEMANTIC_NAME_MAX_LENGTH = 100;

/**
 * Longest evidence excerpt accepted, in characters.
 *
 * The UPPER bound is what makes evidence meaningful: without it a model could
 * "prove" every match by quoting the entire report, which demonstrates nothing.
 * The lower bound lives in evidence.ts (MIN_EVIDENCE_LENGTH) and is enforced by
 * the shared verifier.
 */
export const MAX_EVIDENCE_LENGTH = 500;

/** Most evidence excerpts accepted for one match. Bounds response size. */
export const MAX_EVIDENCE_PER_MATCH = 5;

/** Default per-call timeout. Longer than #87's: the input is a whole report. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 20_000;

/** Default generated-token cap. The reply carries several matches + evidence. */
export const DEFAULT_CLASSIFY_MAX_TOKENS = 1024;

/**
 * Default cap on the assembled report text, in characters.
 *
 * Generous enough that a normal endoscopy report is never near it. Exceeding it
 * SKIPS the report (REPORT_TOO_LONG) rather than truncating - see
 * ClassifyReportErrorCode.
 */
export const DEFAULT_REPORT_MAX_CHARS = 20_000;
