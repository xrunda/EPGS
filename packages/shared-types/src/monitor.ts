/**
 * Stable wire DTOs for the read-only monitor workbench API (issue #7 + #8):
 * `GET /api/monitor/exams`, `GET /api/monitor/exams/:id`,
 * `GET /api/monitor/summary`.
 *
 * These mirror the read-only display model converged by issue #26 - there
 * is deliberately NO report/handling/disposition status anywhere in these
 * shapes. The report body (`reportContent`/`diagnosis`) only ever appears
 * in the DETAIL DTO (`MonitorExamDetailDto`); list responses never carry it
 * (see MonitorExamDto). The detail hits additionally carry the exact rule
 * provenance (`ruleId`/`ruleVersion`, issue #8) so each hit is auditable
 * back to the rule version that produced it. See
 * apps/api/prisma/schema.prisma and docs/data-dictionary.md for the
 * authoritative field-level documentation.
 *
 * Issue #87 adds three fields to the hit row (`semanticFiltered` + the
 * `semantic` verdict) describing whether an AI judged the hit to be a real
 * expression of the rule's intent. This is NOT the closed-loop status the
 * #26 model forbids: it says nothing about whether anyone read, acknowledged
 * or handled the report. The raw hit is still always present and its
 * deterministic `level` is unchanged.
 *
 * Issue #88 (PR-B) adds the report-level AI side: where the record's current
 * attention level came FROM (`attentionSource`) and what the AI read out of the
 * whole report (`aiSemantics` + `aiJudged`). Both live on WORKBENCH-ONLY
 * extension interfaces (MonitorExamWorkbenchDto / MonitorExamWorkbenchDetailDto)
 * rather than on the base DTOs, so the alert-link H5 surface - which aliases the
 * base detail type - cannot name them. Levels and names here are configured
 * values snapshotted at judge time, not a model's classification, and no audit
 * field (hash, model, latency, error) ever crosses this boundary.
 */

import { AttentionLevelDto } from './attention-semantics';
import { MatchFieldDto, MonitorLevelDto, SemanticConfidenceDto, SemanticStatusDto } from './rules';

export type { AttentionLevelDto, MatchFieldDto, MonitorLevelDto, SemanticConfidenceDto, SemanticStatusDto };

/**
 * Patient type as shown in the workbench: the source code (PAADM_Type raw
 * value, e.g. `I`/`O`) is kept verbatim, and `name` carries the CONFIRMED
 * Chinese meaning (住院/门诊/…). Unknown codes keep `name: null` - the
 * client renders the raw code rather than any guessed label.
 */
export interface MonitorPatientTypeDto {
  code: string | null;
  name: string | null;
}

/**
 * The read-only row snapshot shared by every surface that lists records - the
 * workbench list (`GET /api/monitor/exams`, which serves the wider
 * MonitorExamWorkbenchDto) and the alert-link H5 list (`GET
 * /api/alert-links/me/exams`, which serves exactly this). NO
 * reportContent/diagnosis (detail endpoint only) and NO disposition/status.
 */
export interface MonitorExamDto {
  recordId: string;
  monitorLevel: MonitorLevelDto;
  patientName: string | null;
  department: string | null;
  bedNo: string | null;
  patientType: MonitorPatientTypeDto;
  examItem: string | null;
  /** 'YYYY-MM-DD' in Asia/Shanghai, derived from the UTC examTime; null when examTime is null. */
  examDate: string | null;
  /** 'HH:mm:ss' in Asia/Shanghai; null when examTime is null. */
  examTime: string | null;
  /** Distinct matched keywords, ordered by earliest matchedAt. */
  matchedKeywords: string[];
}

/**
 * One hit-evidence row shown in the workbench detail drawer (issue #8).
 *
 * `matchedField` mirrors the `MatchField` enum stored on the match and the
 * rule. It locates the hit within the report, mapping to the issue #8 spec's
 * `field(REPORT_CONTENT/DIAGNOSIS)` as follows:
 *
 * | matchedField        | 报告位置                     | reportContent/diagnosis |
 * | ------------------- | ---------------------------- | ----------------------- |
 * | `FINDINGS`          | 报告内容（所见描述）         | 命中在 `reportContent`  |
 * | `IMPRESSION`        | 诊断意见                     | 命中在 `diagnosis`      |
 * | `REPORT_TEXT`/`OTHER` | 全文（两个字段都查）        | 可能命中任意一个        |
 * | `STUDY_DESCRIPTION` | 检查描述（当前无独立文本源） | —                       |
 *
 * `ruleId`/`ruleVersion` pin the exact rule version that produced the hit
 * (rules are versioned, never deleted — the FK is RESTRICT — so the
 * reference stays resolvable and auditable).
 */
export interface MonitorExamHitDto {
  /** The monitor_rule row that produced this hit. */
  ruleId: string;
  /** Version of that rule at match time (rules are immutable + versioned). */
  ruleVersion: number;
  keyword: string;
  level: MonitorLevelDto;
  matchedField: MatchFieldDto;
  /** Nulled when the server masks HIGH-sensitivity fields (issue #13). */
  contextSnippet: string | null;
  /** ISO 8601 UTC instant. */
  matchedAt: string;
  /**
   * Issue #87: true = this hit was judged NOT to express the rule's
   * `semanticIntent`, so it does not count as an effective attention result -
   * it is excluded from `MonitorExamDto.matchedKeywords`, from the keyword
   * filter, from the push keyword counts, and from the record's
   * `monitorLevel`. The hit row itself is never hidden or deleted (the raw
   * keyword evidence is permanent); the detail drawer shows it with a
   * "未计入关注" annotation.
   *
   * `level` is deliberately NOT adjusted: it stays the deterministic keyword
   * level, so the workbench never implies the model classified anything.
   */
  semanticFiltered: boolean;
  /** Issue #87: the current AI verdict, or null when the hit was never judged. */
  semantic: MonitorHitSemanticDto | null;
}

/**
 * Issue #87: the newest AI judgement on a hit. Present only when the model
 * actually returned a usable verdict - a hit that was never judged (no
 * `semanticIntent`, judge disabled) or whose last attempt failed has
 * `semantic: null`, and in both cases the hit stands.
 *
 * `status`/`confidence` are the model's OPINION; `semanticFiltered` on the hit
 * is the DECISION, which deterministic code makes. They can disagree in one
 * direction only: a NEGATED verdict at MEDIUM/LOW confidence leaves
 * `semanticFiltered` false.
 */
export interface MonitorHitSemanticDto {
  status: SemanticStatusDto;
  confidence: SemanticConfidenceDto;
  /**
   * The model's own one-sentence explanation, in Chinese. Nulled when the
   * server masks HIGH-sensitivity fields (issue #13) - the model may quote the
   * report body into it, so it is report-adjacent text.
   */
  reason: string | null;
  /** ISO 8601 UTC instant of the call that produced this verdict. */
  judgedAt: string;
}

/**
 * Present ONLY when the server masked HIGH-sensitivity fields for the
 * requesting user (issue #13 - a user without patientDetail rights gets
 * reportContent/diagnosis/contextSnippet nulled, patientName partially
 * masked, bedNo as "***"). Absent when the data is returned unmasked, so a
 * null reportContent with no dataAccess flag means the report truly has no
 * body, not that it was redacted.
 */
export interface MonitorDataAccess {
  masked: boolean;
}

/**
 * Full snapshot for `GET /api/monitor/exams/:id` (the read-only detail
 * drawer). Extends the list row with the report body (HIGH sensitivity -
 * this is why it is only served on demand, never in the list) and all hits.
 * When the requesting user lacks patientDetail rights, reportContent /
 * diagnosis / each hit's contextSnippet are nulled and dataAccess.masked is
 * set (issue #13).
 */
export interface MonitorExamDetailDto extends MonitorExamDto {
  reportContent: string | null;
  diagnosis: string | null;
  /** Ordered matchedAt asc, id asc. */
  hits: MonitorExamHitDto[];
  /** Present only when the server masked sensitive fields for this user. */
  dataAccess?: MonitorDataAccess;
}

/**
 * Issue #88 (PR-B): WHERE this record's current attention level came from.
 *
 * A statement about PROVENANCE, never about severity, and it never influences a
 * level - the level is already decided by `computeEffectiveLevel` in the worker.
 * Derived deterministically in the API read path from data the record already
 * carries; no extra column, no migration.
 *
 * | value       | condition                                          | badge            |
 * | ----------- | -------------------------------------------------- | ---------------- |
 * | `RULE`      | effective keyword hits, no AI finding              | 关键词           |
 * | `AI_REPORT` | no effective keyword hit, AI finding               | AI 语义          |
 * | `BOTH`      | both - regardless of which one is HIGHER           | 关键词 + AI 语义 |
 * | `NONE`      | neither, i.e. the record is UNCLASSIFIED           | no badge         |
 *
 * `BOTH` deliberately does NOT mean "the AI raised the level": a keyword RED
 * with an AI YELLOW is still `BOTH`, because both paths found something a
 * doctor should read. `NONE` is a member rather than null because
 * UNCLASSIFIED records are list-visible by design, so "neither path found
 * anything" is a real state - a nullable field would re-create the ambiguous
 * NULL that schema.prisma's attentionLevel comment warns about.
 */
export type MonitorAttentionSourceDto = 'RULE' | 'AI_REPORT' | 'BOTH' | 'NONE';

/** Mirrors Prisma's ReportAiField enum: which report column an excerpt sits in. */
export type ReportAiFieldDto = 'EXAM_ITEM' | 'FINDINGS' | 'IMPRESSION';

/**
 * Issue #88 (PR-B): one verbatim excerpt backing an AI finding.
 *
 * The excerpt is reconstructed SERVER-SIDE on every read, from
 * `monitor_report_ai_evidence`'s stored offsets against the CURRENT report
 * text - the audit tables deliberately store only the hash and the offsets,
 * never the excerpt itself. `text` is therefore never the stored hash, and no
 * audit vocabulary (hash, model, latency) reaches this shape.
 */
export interface MonitorAiEvidenceDto {
  field: ReportAiFieldDto;
  text: string;
}

/**
 * Issue #88 (PR-B): one attention semantic the AI verified against this report.
 *
 * `name` and `attentionLevel` are the CONFIGURED values snapshotted at judge
 * time (the semantic is versioned, so a later re-wording cannot rewrite what
 * this finding meant) - they are not a second model opinion. `confidence` is
 * the model's self-reported certainty and is descriptive only: #88 never
 * filters or ranks on it.
 */
export interface MonitorAiSemanticDto {
  /** The exact attention_semantic version row the finding was made against. */
  semanticId: string;
  semanticVersion: number;
  /** Configured name snapshot, in the hospital's own words. */
  name: string;
  attentionLevel: AttentionLevelDto;
  confidence: SemanticConfidenceDto;
  /**
   * The model's one-sentence Chinese explanation. Nulled when the server masks
   * HIGH-sensitivity fields - the model may quote the report body into it, so
   * it is report-adjacent text, exactly like a hit's `contextSnippet`.
   */
  reason: string | null;
  /**
   * Verified excerpts of the CURRENT report text, each labelled with the field
   * it came from. Empty when masked, and also empty (never absent, never a
   * 500) when a stored offset no longer lands on the text it was computed
   * against - dropping the excerpt rather than the finding keeps the drawer
   * consistent with a `monitorLevel` that still counts it.
   */
  evidence: MonitorAiEvidenceDto[];
}

/**
 * Issue #88 (PR-B): the workbench list row. An EXTENSION of MonitorExamDto, not
 * a change to it, so `AlertLinkExamListDto` (which keeps `MonitorExamDto[]`)
 * is structurally incapable of carrying the new field to the alert-link H5
 * page. Same reasoning for MonitorExamWorkbenchDetailDto below, which is why
 * `AlertLinkExamDetailDto = MonitorExamDetailDto` stays byte-identical.
 */
export interface MonitorExamWorkbenchDto extends MonitorExamDto {
  attentionSource: MonitorAttentionSourceDto;
}

/**
 * Issue #88 (PR-B): the workbench detail row. Extends MonitorExamDetailDto for
 * the same reason as the list extension above.
 */
export interface MonitorExamWorkbenchDetailDto extends MonitorExamDetailDto {
  attentionSource: MonitorAttentionSourceDto;
  /**
   * True when the AI has judged THIS report version - an OK attempt whose
   * `reportVersion` matches the record's. Carries no timestamp, model or
   * latency: it only lets the doctor tell "the AI looked and found nothing"
   * apart from "the AI never looked". Says nothing about whether it found
   * anything; read `aiSemantics` for that.
   */
  aiJudged: boolean;
  /**
   * Ordered by attention level priority (RED -> YELLOW -> GREEN), then by the
   * stored ordinal, so the doctor reads the most attention-worthy finding
   * first - the same ordering the level itself was computed under. Empty when
   * no current finding is showable; see aiJudged.
   */
  aiSemantics: MonitorAiSemanticDto[];
}

/** Paginated response envelope for `GET /api/monitor/exams`. */
export interface PaginatedMonitorExams {
  items: MonitorExamWorkbenchDto[];
  total: number;
  page: number;
  pageSize: number;
  /** Present only when the server masked sensitive fields for this user. */
  dataAccess?: MonitorDataAccess;
}

/**
 * Level counts for `GET /api/monitor/summary`, computed under the SAME
 * filters as the list. `total` is the sum of the five buckets (every
 * monitor_record row falls into exactly one level bucket).
 */
export interface MonitorSummaryDto {
  total: number;
  red: number;
  yellow: number;
  green: number;
  unclassified: number;
}

/** Whitelisted sort columns for `GET /api/monitor/exams`. */
export type ExamsSortBy =
  'examTime' | 'currentLevel' | 'patientName' | 'firstMatchedAt' | 'lastMatchedAt';

export type ExamsSortDir = 'asc' | 'desc';

/** Filters shared by the list and summary endpoints. */
export interface MonitorFiltersQuery {
  /** 'YYYY-MM-DD' - inclusive lower bound, interpreted as the start of that Asia/Shanghai day. */
  examDateFrom?: string;
  /** 'YYYY-MM-DD' - exclusive upper bound, i.e. records strictly before the NEXT Asia/Shanghai day. */
  examDateTo?: string;
  /** Department filter (case-insensitive, exact match). */
  department?: string;
  /** Patient type source code (exact match, e.g. I/O). */
  patientTypeCode?: string;
  /** Attention level (RED/YELLOW/GREEN/UNCLASSIFIED). */
  level?: MonitorLevelDto;
  /** Exam item substring (case-insensitive). */
  examItem?: string;
  /** Patient name substring (case-insensitive). Combined with `keyword` via AND, not OR. */
  patientName?: string;
  /** Exact matched-rule keyword (from MonitorRuleDto.keyword) - NOT report body text. Combined with `patientName` via AND. */
  keyword?: string;
}

/** Query params for `GET /api/monitor/exams`. */
export interface ListMonitorExamsQuery extends MonitorFiltersQuery {
  page?: number;
  pageSize?: number;
  sortBy?: ExamsSortBy;
  sortDir?: ExamsSortDir;
}

/** Query params for `GET /api/monitor/summary` - identical filters to the list. */
export type MonitorSummaryQuery = MonitorFiltersQuery;
