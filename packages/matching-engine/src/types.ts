/**
 * Public types for the keyword-matching engine (issue #5).
 *
 * This module is a pure, deterministic, side-effect-free function library:
 * no database access, no HTTP calls, no LLM calls. It classifies report
 * text into a MonitorLevel by matching against a rule *snapshot* supplied
 * by the caller - it never fetches rules itself.
 *
 * Enum-shaped fields below are intentionally redeclared as plain string
 * union / const-object types rather than imported from `@prisma/client`.
 * Reasons:
 *  - apps/worker must be able to depend on this package without pulling in
 *    the full generated Prisma Client (which apps/worker does not and
 *    should not depend on - it talks to Postgres only via apps/api /
 *    future sync APIs, not directly).
 *  - Keeping this package free of a Prisma Client dependency keeps it a
 *    true "pure function" library per the issue #5 acceptance criteria.
 *
 * The *names and values* are kept identical to apps/api/prisma/schema.prisma
 * (`MonitorLevel`, `MatchField`, `MatchMode`) so callers can pass values
 * straight through from Prisma-typed rows without any translation layer.
 * If the Prisma schema's enums ever change, these must be updated to match.
 */

/** Mirrors Prisma enum `MonitorLevel`. Priority for "highest wins" is RED > YELLOW > GREEN > UNCLASSIFIED. */
export type MonitorLevel = 'RED' | 'YELLOW' | 'GREEN' | 'UNCLASSIFIED';

/** Mirrors Prisma enum `MatchField`. This engine only interprets FINDINGS, IMPRESSION and ALL_TEXT-style `OTHER`/`REPORT_TEXT`/`STUDY_DESCRIPTION` are accepted but currently have no dedicated report text source (see RuleSnapshot.matchField doc). */
export type MatchField = 'FINDINGS' | 'IMPRESSION' | 'REPORT_TEXT' | 'STUDY_DESCRIPTION' | 'OTHER';

/** Mirrors Prisma enum `MatchMode`. */
export type MatchMode = 'EXACT' | 'CONTAINS' | 'REGEX';

/**
 * Ordered highest-to-lowest MonitorLevel priority, per issue #5's business
 * rule: "同一报告命中多个等级时取红 > 黄 > 绿". Exported so callers/tests
 * can reuse the same ordering instead of re-encoding it.
 */
export const LEVEL_PRIORITY: readonly MonitorLevel[] = ['RED', 'YELLOW', 'GREEN', 'UNCLASSIFIED'];

/**
 * A single report field this engine knows how to source text for.
 * `ALL` is not itself a text source - a rule with matchField `ALL`
 * (represented here by the caller using MatchField 'REPORT_TEXT' or by
 * omitting a narrower field - see RuleSnapshot doc) is expanded internally
 * to check both FINDINGS and IMPRESSION.
 */
export type MatchableTextField = 'FINDINGS' | 'IMPRESSION';

/**
 * A rule snapshot: the minimum, non-Prisma-coupled shape of a MonitorRule
 * row needed to run matching. Field names intentionally mirror
 * apps/api/prisma/schema.prisma's `MonitorRule` model (camelCase) so a
 * Prisma-loaded row can be passed through with a simple object literal /
 * pick, without importing `@prisma/client` types into this package.
 *
 * `ruleId` + `ruleVersion` together are what MonitorMatch.ruleId /
 * (denormalized) version-at-match-time needs for a stable audit trail -
 * see schema.prisma MonitorRule.version / ruleGroupId doc.
 */
export interface RuleSnapshot {
  /** MonitorRule.id (UUID string). Not validated as UUID by this package. */
  ruleId: string;
  /** MonitorRule.version at the time this snapshot was taken. */
  ruleVersion: number;
  /** MonitorRule.keyword. */
  keyword: string;
  /** MonitorRule.level - the level this rule assigns when it matches. */
  level: MonitorLevel;
  /**
   * MonitorRule.matchField. `FINDINGS` -> describeText only, `IMPRESSION`
   * -> diagnoseText only. `REPORT_TEXT` and `OTHER` are treated as "check
   * every text field this engine has" (i.e. behave like the issue's "ALL"
   * requirement: "ALL 同时检查检查所见和诊断意见"), since the current
   * schema enum has no literal `ALL` value (see docs/data-dictionary.md).
   * `STUDY_DESCRIPTION` is accepted for forward compatibility but this
   * engine has no study-description text input in MatchInput yet, so
   * rules scoped to it never match today (documented no-op, not an error).
   */
  matchField: MatchField;
  /** MonitorRule.matchMode - EXACT (whole-field exact phrase), CONTAINS (substring), or REGEX. */
  matchMode: MatchMode;
  /**
   * Case sensitivity for this rule. Not a distinct MatchMode value (the
   * Prisma schema's MatchMode enum is EXACT/CONTAINS/REGEX only) - modeled
   * as an orthogonal flag so any MatchMode can be case-insensitive, per
   * issue #5's "ca / CA / Ca 在不区分大小写规则下命中" requirement.
   * Defaults to `false` (case-sensitive) when omitted, matching CONTAINS'
   * default literal-substring behavior.
   */
  caseSensitive?: boolean;
  /** Whether this rule is enabled. Disabled rules are skipped entirely by matchReport - callers may also pre-filter, but the engine re-checks defensively. */
  enabled: boolean;
}

/** Upstream report review/finalization status, mirrors Prisma enum `ReportStatus`. Optional/loose here since this package must not require the full Prisma enum. */
export type ReportStatus = 'PRELIMINARY' | 'FINAL' | 'AMENDED' | 'UNKNOWN';

/**
 * Input to `matchReport`. Pure data - no live report fetch, no DB handle.
 */
export interface MatchInput {
  /** Source report identifier (PacsReportDto.reportId / MonitorRecord.reportId), for traceability in results/logs. Not used for matching logic. */
  reportId: string;
  /** Report version at the time of matching (MonitorRecord.reportVersion / MonitorMatch.reportVersion). */
  reportVersion: number;
  /** Exam findings text ("检查所见"), verbatim - equivalent to PacsReportDto.describeText. Null/empty is valid input (no findings text). */
  describeText: string | null;
  /** Diagnostic impression text ("诊断意见"), verbatim - equivalent to PacsReportDto.diagnoseText. Null/empty is valid input. */
  diagnoseText: string | null;
  /**
   * Whether the *report itself* has completed human review upstream
   * (e.g. PacsReportStatus FINAL_REVIEWED / REVIEWED). The engine does not
   * infer this - the caller passes it through, and the engine only
   * attaches a disclaimer flag to the output when it is false. This is
   * NOT about whether the *match* has been triaged by an operator
   * (that's MonitorAction/HandlingStatus, entirely out of scope here).
   */
  isReviewed: boolean;
  /** Optional richer status snapshot, carried through to the result's disclaimer for display context. Purely informational - matching logic only branches on `isReviewed`. */
  reportStatus?: ReportStatus;
  /** The enabled rule snapshot(s) to evaluate against this report. Order does not affect the result (matchReport sorts/aggregates deterministically). */
  rules: RuleSnapshot[];
}

/**
 * One matched keyword occurrence, aggregated per (rule, field) pair.
 * "合并展示，但需保留命中计数": if a keyword occurs multiple times in the
 * same field for the same rule, they collapse into one MatchedRule entry
 * with `occurrenceCount` > 1 and one `occurrences` entry per hit.
 */
export interface MatchOccurrence {
  /** Start offset (inclusive, UTF-16 code unit index) of this occurrence in the ORIGINAL (non-normalized) field text. */
  start: number;
  /** End offset (exclusive, UTF-16 code unit index) of this occurrence in the ORIGINAL field text. */
  end: number;
  /**
   * De-identification-safe context excerpt: up to N characters before and
   * after the match, taken from the ORIGINAL text (not normalized), per
   * issue #5's "保留...上下文（如命中词前后各 N 个字符的摘录）" and the
   * schema's MonitorMatch.contextSnippet (varchar(500)) budget. Long
   * excerpts are truncated with an ellipsis marker; this snippet is meant
   * for display, not as a substitute for the original report.
   */
  contextSnippet: string;
}

export interface MatchedRule {
  ruleId: string;
  ruleVersion: number;
  keyword: string;
  level: MonitorLevel;
  /** The field this rule actually matched in (never `ALL` - always the concrete field the text came from). */
  field: MatchableTextField;
  matchMode: MatchMode;
  /** Number of occurrences found for this (rule, field) pair. Always === occurrences.length. */
  occurrenceCount: number;
  occurrences: MatchOccurrence[];
}

/**
 * Advisory flag attached to every MatchResult so upstream UI can render
 * "仅用于监测，不作为正式诊断" (monitoring-only, not a formal diagnosis)
 * without re-deriving it. Per issue #5 acceptance criteria this is
 * caller-driven (via MatchInput.isReviewed), never inferred by the engine.
 */
export interface MatchDisclaimer {
  /** Always true - every result produced by this engine carries the monitoring-only disclaimer, regardless of review status. Levels are management attention tiers, never a clinical severity or diagnosis. */
  monitoringOnly: true;
  /** Echoes MatchInput.isReviewed. */
  isReviewed: boolean;
  /** Echoes MatchInput.reportStatus, if provided. */
  reportStatus?: ReportStatus;
  /** Human-readable disclaimer text (Chinese, matching the issue's required wording), for direct display without the UI needing its own copy. */
  message: string;
}

export interface MatchResult {
  reportId: string;
  reportVersion: number;
  /** Highest MonitorLevel across all matches (RED > YELLOW > GREEN), or UNCLASSIFIED if nothing matched / there was no matchable text. */
  level: MonitorLevel;
  /** All matched rules with full evidence. Empty array when level is UNCLASSIFIED. */
  matchedRules: MatchedRule[];
  disclaimer: MatchDisclaimer;
}
