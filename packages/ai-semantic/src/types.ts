/**
 * Public types for the shared AI semantic engine (issue #87).
 *
 * This package is the LOWER LAYER both #87 (Validate Match, implemented here)
 * and #88 (Classify Report, not implemented yet) build on: the model-client
 * seam, the structured-output contract and its strict validation, evidence
 * verification, deterministic disposition, fail-open error taxonomy, audit
 * hashing and task/prompt versioning. It is framework- and DB-agnostic in the
 * same sense as @epgs/matching-engine: it never imports `@prisma/client` and
 * never opens a database connection. The MODEL is reached through an injected
 * `SemanticModelClient`, so unit tests supply a fake and no test ever needs a
 * real model.
 *
 * DIVISION OF RESPONSIBILITY - the single most important thing in this file:
 *
 *   The model INTERPRETS. It says what a piece of report text means and how
 *   sure it is. It is asked for a judgement about language.
 *
 *   The CODE DECIDES. Whether a judgement is allowed to remove a keyword hit
 *   from the attention result is decided by `decideDisposition` in
 *   disposition.ts - a pure function with no model input beyond the validated
 *   verdict fields. The model is never asked "should this be filtered", never
 *   sees the red/yellow/green levels, and cannot set a level.
 *
 * Enum-shaped fields are redeclared as plain string unions rather than imported
 * from `@prisma/client` (same reasoning as matching-engine/src/types.ts). The
 * names and values are kept identical to apps/api/prisma/schema.prisma
 * (`SemanticStatus`, `SemanticConfidence`, `SemanticTask`) so adapters can pass
 * values straight through without a translation layer. If the Prisma schema's
 * enums change, these must be updated to match.
 */

/**
 * What the hit's context means, per the model. Mirrors Prisma enum
 * `SemanticStatus`.
 *
 * This is NOT a monitor level and is never mapped to one. It describes the
 * LANGUAGE of the sentence relative to the keyword, nothing about clinical
 * severity.
 *
 *  PRESENT   - the context asserts the finding is there now
 *              (胃窦见巨大溃疡).
 *  NEGATED   - the context asserts it is NOT there
 *              (未见明显溃疡 / 未见异常).
 *  SUSPECTED - the context raises it as a possibility without asserting it
 *              (考虑胃溃疡可能 / 不能除外溃疡). Note this covers both "probably
 *              yes" and "cannot rule out" - ambiguity is not negation, and a
 *              doctor flagging a maybe still wants to see it.
 *  HISTORY   - the context mentions it only as past history / prior exam,
 *              not as a current finding (既往胃溃疡病史).
 *  UNCERTAIN - the context does not contain enough information to decide.
 *              Also the correct answer when the excerpt is too short,
 *              truncated, or ambiguous.
 */
export type SemanticStatus = 'PRESENT' | 'NEGATED' | 'SUSPECTED' | 'HISTORY' | 'UNCERTAIN';

/**
 * How sure the model is of its `SemanticStatus`. Mirrors Prisma enum
 * `SemanticConfidence`.
 *
 * Only HIGH confidence ever authorizes removing a hit. MEDIUM and LOW always
 * fail open and keep it - see disposition.ts. Confidence refers to the STATUS
 * judgement only; it is not a clinical confidence and not a probability.
 */
export type SemanticConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Which AI task produced a judgement. Mirrors Prisma enum `SemanticTask`.
 * #88's report-classification task will add its own value when it lands; #87
 * owns only VALIDATE_MATCH.
 */
export type SemanticTask = 'VALIDATE_MATCH';

/** Runtime list of every SemanticStatus, for strict wire-value validation. */
export const SEMANTIC_STATUSES: readonly SemanticStatus[] = [
  'PRESENT',
  'NEGATED',
  'SUSPECTED',
  'HISTORY',
  'UNCERTAIN',
];

/** Runtime list of every SemanticConfidence, for strict wire-value validation. */
export const SEMANTIC_CONFIDENCES: readonly SemanticConfidence[] = ['HIGH', 'MEDIUM', 'LOW'];

/**
 * The model's validated verdict for one keyword hit - the Validate Match
 * output contract, after strict parsing. Shape follows issue #87's
 * `{ matched, semantic_status, reason, evidence, confidence }` plus
 * `intentExcludesHistory` (the sixth field, added because the disposition
 * matrix needs the model's reading of the doctor's intent to be a separate,
 * inspectable value rather than something the model folds into its status
 * choice - see disposition.ts HISTORY handling).
 *
 * On the wire the model emits snake_case (`semantic_status`,
 * `intent_excludes_history`); this interface is the camelCase form the rest of
 * the TypeScript codebase uses. The wire schema is enforced in
 * validate-match.ts.
 */
export interface ValidateMatchVerdict {
  /**
   * Whether the context expresses what the rule watches for. `false` means
   * "the keyword is here, but the sentence is not about the thing the doctor
   * meant".
   *
   * Recorded for audit and cross-checked for coherence against
   * `semanticStatus` (see disposition.ts isCoherent) - but NOT read by the
   * disposition matrix, which is driven by status + confidence so that there
   * is exactly one place where "may this filter" is decided.
   */
  matched: boolean;

  /** What the context means, linguistically. */
  semanticStatus: SemanticStatus;

  /** The model's confidence in `semanticStatus`. */
  confidence: SemanticConfidence;

  /**
   * One short sentence in Chinese explaining the verdict, for the audit trail
   * and the workbench's "为什么" display. Bounded (see MAX_REASON_LENGTH).
   */
  reason: string;

  /**
   * An excerpt copied VERBATIM from the context the model was shown that
   * justifies the verdict. Not trusted: it is located in the context by
   * `verifyEvidence` before the verdict may be used (issue #87: an
   * unverifiable verdict must fail open). Never persisted verbatim - only its
   * hash and the offsets where it was found.
   */
  evidence: string;

  /**
   * The model's reading of the rule's natural-language semantic intent: does
   * that intent treat a mere past history as a non-hit?
   *
   * This exists because "既往胃溃疡病史" is a real mention of the keyword that
   * may or may not be what the doctor wants to be woken up about - only the
   * doctor's own intent text says which. The model reports its reading; the
   * CODE applies it, and only HIGH confidence plus `true` here can filter a
   * HISTORY hit.
   */
  intentExcludesHistory: boolean;
}

/**
 * Why a decision came out the way it did - stored on every audit row so a
 * "kept" hit is as explainable as a filtered one. Mirrors the
 * monitor_match_semantic.decision_reason column (varchar(50)).
 *
 * Every value ending in `_KEEP` is a FAIL-OPEN outcome: the original keyword
 * hit survives. They are broken out by cause so the ratio of "AI was wrong"
 * to "AI could not be reached" to "the model contradicted itself" is
 * measurable from the audit table alone, without reading logs.
 */
export type SemanticDecisionReason =
  // --- outcomes driven by a validated verdict ---
  | 'PRESENT_KEEP'
  | 'SUSPECTED_KEEP'
  | 'UNCERTAIN_KEEP'
  | 'NEGATED_HIGH_FILTER'
  | 'NEGATED_NOT_HIGH_KEEP'
  | 'HISTORY_HIGH_FILTER'
  | 'HISTORY_NOT_HIGH_KEEP'
  | 'HISTORY_INTENT_INCLUDES_KEEP'
  | 'MALFORMED_VERDICT_KEEP'
  // --- fail-open outcomes caused by a failure, never by a judgement ---
  | 'EVIDENCE_UNVERIFIED_KEEP'
  | 'TIMEOUT_KEEP'
  | 'NETWORK_KEEP'
  | 'HTTP_ERROR_KEEP'
  | 'INVALID_JSON_KEEP'
  | 'SCHEMA_INVALID_KEEP'
  | 'UNKNOWN_ENUM_KEEP'
  | 'EMPTY_CONTEXT_KEEP'
  | 'MODEL_ERROR_KEEP'
  // --- not a judgement at all: the rule has no semantic intent ---
  | 'NO_INTENT_SKIP';

/**
 * Machine-readable failure classification. Written to the audit row's `error`
 * column; also what the caller logs.
 *
 * HARD RULE: these are the ONLY things that may ever be written there. Raw
 * model output, prompts, context text and report bodies must never reach the
 * error column or a log line - a model that echoes the report back would
 * otherwise turn the audit table into a second copy of patient data. The
 * `HTTP_<status>` form is the one place a number from the transport appears,
 * and it is a status code, not a body.
 */
export type SemanticErrorCode =
  /** The call exceeded timeoutMs and was aborted. */
  | 'TIMEOUT'
  /** The request never produced a response (DNS, connection refused, socket reset). */
  | 'NETWORK'
  /** The gateway answered with a non-2xx status; the code carries the status. */
  | `HTTP_${number}`
  /** A response arrived but contained no JSON object we could extract. */
  | 'INVALID_JSON'
  /** JSON parsed, but required fields were missing or the wrong type. */
  | 'SCHEMA_INVALID'
  /** JSON parsed, fields present, but an enum-shaped value is not a known member. */
  | 'UNKNOWN_ENUM'
  /** The verdict's evidence could not be located in the context actually sent. */
  | 'EVIDENCE_UNVERIFIED'
  /** No usable context could be built (empty field text, or offsets out of range). */
  | 'EMPTY_CONTEXT'
  /** Anything else thrown by the client that we cannot classify. */
  | 'MODEL_ERROR';

/**
 * A context window sliced out of a report field: the exact text handed to the
 * model, plus where it came from.
 *
 * `text` is ALWAYS exactly `fieldText.slice(start, end)` - no injected
 * markers, no ellipsis, no rewriting. That invariant is what makes evidence
 * verification meaningful: the model's evidence must be a literal substring of
 * this text, and the offsets we record point into the same report field an
 * auditor already has.
 */
export interface ContextWindow {
  /** The excerpt itself, verbatim. */
  text: string;
  /** Inclusive start offset into the field text. */
  start: number;
  /** Exclusive end offset into the field text. */
  end: number;
  /** True when `text` is the whole field (nothing was left out). */
  isWholeField: boolean;
}

/**
 * Where a verified evidence excerpt sits. Never the excerpt itself - the audit
 * table stores these two offsets plus `hash`, and an auditor recomputes the
 * text from the report body if they are entitled to read it.
 */
export interface VerifiedEvidence {
  /** sha256 (hex) of the evidence string as returned by the model. */
  hash: string;
  /** Inclusive start offset into the same field text as the context. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/**
 * The deterministic decision for one hit. Produced only by `decideDisposition`.
 */
export interface SemanticDisposition {
  /**
   * True means "this hit must not count as an effective attention result".
   *
   * Nothing but `decideDisposition` may produce this, and it can only be true
   * for a validated, evidence-verified, coherent verdict that is either
   * NEGATED+HIGH or HISTORY+HIGH-with-an-intent-that-excludes-history.
   */
  filtered: boolean;
  /** Why - always populated, for both outcomes. */
  reason: SemanticDecisionReason;
}

/**
 * Everything needed to run Validate Match for one hit. Assembled by the
 * caller's DB adapter from a MonitorMatch row plus its MonitorRule.
 *
 * `fieldText` is the FULL original text of the field the keyword hit
 * (`monitor_record.report_content` for FINDINGS, `.diagnosis` for IMPRESSION).
 * The context window is derived from it here rather than passed in, so the
 * "what exactly was sent" question has one answer in one place.
 */
export interface ValidateMatchInput {
  /** The rule's keyword - what matched, verbatim. */
  keyword: string;
  /**
   * The doctor's natural-language statement of what this keyword is meant to
   * catch. Empty/whitespace means "not configured"; the caller is expected to
   * skip such rules without calling, and `semanticIntentConfigured` is the
   * shared predicate for that.
   */
  semanticIntent: string;
  /** The field text the keyword matched in, verbatim. */
  fieldText: string;
  /** Inclusive start offset of the anchor occurrence in `fieldText`. */
  matchStart: number;
  /** Exclusive end offset of the anchor occurrence in `fieldText`. */
  matchEnd: number;
  /**
   * Every other occurrence of the same keyword in the same field, if the
   * caller knows them. Optional: when absent they are re-derived from
   * `fieldText` (see context.ts), which is the normal path because
   * monitor_match keeps only ONE row per (record, rule, field, version).
   */
  siblingOccurrences?: ReadonlyArray<{ start: number; end: number }>;
  /** Rule match field, for the prompt's framing only - never a matching input. */
  matchField?: string;
  /** Rule match mode, for the prompt's framing only. */
  matchMode?: string;
  /**
   * Rule case sensitivity. Only used when sibling occurrences must be
   * re-derived: the re-derivation runs the real matching strategies, and they
   * need the same flag the rule matched with or they would find a different
   * set of occurrences than the ones on record.
   */
  caseSensitive?: boolean;
  /** Report version, carried for traceability in the audit row. */
  reportVersion?: number;
}

/** One attempt's full result. Pure data - the caller persists it. */
export interface ValidateMatchResult {
  /** Whether the CALL produced a usable, verified verdict. */
  outcome: 'OK' | 'ERROR';
  /** Always VALIDATE_MATCH today. */
  task: SemanticTask;
  /** Prompt/contract version that produced this attempt (see PROMPT_VERSION). */
  taskVersion: string;
  /** Model identifier as configured. */
  model: string;
  /** Model version/revision as reported by the gateway, when it reports one. */
  modelVersion: string | null;
  /** Wall-clock duration of the model call; null when no call was made. */
  latencyMs: number | null;
  /** Machine-readable failure code; null when outcome is OK. */
  error: SemanticErrorCode | null;

  /**
   * The validated verdict; null when outcome is ERROR.
   *
   * Deliberately null for EVIDENCE_UNVERIFIED even though the model did return
   * something parseable: a verdict we could not check must not be written down
   * as if it were a judgement we stand behind. The failure is recorded by
   * `error` + `decision.reason`, which is the honest account of what happened.
   */
  verdict: ValidateMatchVerdict | null;

  /** Where the verified evidence was found; null when unverified/absent. */
  evidence: VerifiedEvidence | null;

  /** The exact excerpt sent to the model, with its provenance. */
  context: ContextWindow;

  /** sha256 of the canonical task input (rule + hit + context). */
  inputHash: string;

  /**
   * sha256 of the context window alone - a sub-hash of `inputHash`, so an
   * auditor can check just the excerpt without reconstructing the whole task
   * input.
   */
  contextHash: string;

  /** The decision, always present - including on every failure. */
  decision: SemanticDisposition;
}

/**
 * Task/prompt contract version, stored on every audit row.
 *
 * Bump this whenever the prompt text or the output schema changes: it is how
 * a historical judgement stays attributable to the exact contract that
 * produced it. Changing the prompt WITHOUT bumping this makes old and new
 * judgements indistinguishable in the audit trail.
 */
export const PROMPT_VERSION = 'validate-match/1';

/** Hard bound on the persisted `reason`, matching the column's varchar(300). */
export const MAX_REASON_LENGTH = 300;

/** Default per-call timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default generated-token cap. The reply is a small JSON object. */
export const DEFAULT_MAX_TOKENS = 512;

/** Default context window budget in characters. */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 400;

/**
 * True when a rule has a semantic intent configured, i.e. when the judge
 * should consider it at all. Rules without one are skipped entirely (no model
 * call, no audit row) so a rule nobody has configured behaves exactly as it
 * did before #87.
 */
export function semanticIntentConfigured(semanticIntent: string | null | undefined): boolean {
  return typeof semanticIntent === 'string' && semanticIntent.trim().length > 0;
}
