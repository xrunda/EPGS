import {
  AttentionLevel,
  MonitorLevel,
  MonitorMatch,
  SemanticConfidence,
  SemanticStatus,
} from '@prisma/client';
import {
  MonitorExamDto,
  MonitorExamHitDto,
  MonitorExamWorkbenchDetailDto,
  MonitorExamWorkbenchDto,
  MonitorHitSemanticDto,
  MonitorPatientTypeDto,
} from '@epgs/shared-types';
import { ReportAiAttemptRow, toAiJudged, toAiSemantics, toAttentionSource } from './report-ai.mapper';
import { formatShanghaiDateTime } from './monitor-time';

/**
 * Maps monitor_record rows to the issue #7/#8 wire DTOs. The list row shape
 * (MonitorExamListRow) deliberately carries ONLY the list-display fields -
 * reportContent/diagnosis never appear in a list query's select, so they
 * cannot leak into the response (they are served only by the detail
 * endpoint via MonitorExamDetailRow). The detail hit rows additionally
 * carry rule provenance (ruleId + the versioned rule's version) per issue
 * #8, so each hit is auditable back to the exact rule that produced it.
 *
 * Issue #88 (PR-B) adds the report-level AI side. `toExamDto` stays the BASE
 * mapper - it is what the alert-link H5 list serves, and it must not grow an
 * AI field - while `toWorkbenchExamDto` is the workbench list row that adds
 * `attentionSource`. The report-level mapping itself lives in
 * report-ai.mapper.ts, where the attempt-selection and excerpt-reconstruction
 * rules are unit-tested on their own.
 */

export interface MonitorExamListRow {
  id: string;
  patientName: string | null;
  department: string | null;
  bedNo: string | null;
  patientTypeCode: string | null;
  patientTypeName: string | null;
  examItem: string | null;
  examTime: Date | null;
  currentLevel: MonitorLevel;
  /**
   * Issue #88: the level the AI path contributed, or NULL when it contributed
   * nothing (never judged, judged as NONE, or the state was reset because the
   * report text changed). One scalar, already on the record - so the list needs
   * no join and cannot carry AI text. It is the same input the level
   * recomputation reads, which is what keeps `attentionSource` consistent with
   * the level rather than a second opinion about it.
   */
  aiAttentionLevel: AttentionLevel | null;
  matches: { keyword: string; matchedAt: Date }[];
}

/**
 * A detail hit = match row + the versioned rule it references (issue #8) + the
 * newest successful AI judgement, if any (issue #87). The judgement array is
 * empty for a hit that was never judged - a rule with no semanticIntent, the
 * judge being off, or every attempt having failed.
 */
export type MonitorExamHitRow = MonitorMatch & {
  rule: { version: number };
  semanticJudgements: SemanticJudgementRow[];
};

/** The newest OK monitor_match_semantic row, as DETAIL_INCLUDE selects it. */
export interface SemanticJudgementRow {
  semanticStatus: SemanticStatus | null;
  confidence: SemanticConfidence | null;
  reason: string | null;
  createdAt: Date;
}

/**
 * Detail row = list row + report body snapshot + full hit rows + the AI
 * attempt rows (issue #88).
 *
 * `reportVersion`/`aiResolvedAt` join the detail row because the AI mapping
 * needs them to pick which attempt describes the report as it is now; they are
 * scalars already on the record, not audit fields of the attempt.
 */
export interface MonitorExamDetailRow extends MonitorExamListRow {
  reportContent: string | null;
  diagnosis: string | null;
  reportVersion: number;
  aiResolvedAt: Date | null;
  matches: MonitorExamHitRow[];
  /** OK-outcome attempts, newest first. Empty when the report was never judged. */
  reportAiAttempts: ReportAiAttemptRow[];
}

/**
 * The BASE list row (no AI field). Serves the alert-link H5 list, whose wire
 * type is MonitorExamDto - adding a field here would push it to a surface that
 * must not carry AI content.
 */
export function toExamDto(row: MonitorExamListRow): MonitorExamDto {
  const shanghai = row.examTime ? formatShanghaiDateTime(row.examTime) : null;
  return {
    recordId: row.id,
    monitorLevel: row.currentLevel,
    patientName: row.patientName,
    department: row.department,
    bedNo: row.bedNo,
    patientType: toPatientType(row.patientTypeCode, row.patientTypeName),
    examItem: row.examItem,
    examDate: shanghai?.date ?? null,
    examTime: shanghai?.time ?? null,
    matchedKeywords: distinctKeywords(row.matches),
  };
}

/**
 * The workbench list row = the base row + where the level came from.
 *
 * The list's `matches` are already filtered to effective hits (LIST_SELECT's
 * `semanticFiltered: false`), so "has a keyword finding" is simply "has any
 * match" here - unlike the detail, where the unfiltered hits are present.
 */
export function toWorkbenchExamDto(row: MonitorExamListRow): MonitorExamWorkbenchDto {
  return {
    ...toExamDto(row),
    attentionSource: toAttentionSource(row.matches.length > 0, row.aiAttentionLevel ?? null),
  };
}

export function toExamDetailDto(row: MonitorExamDetailRow): MonitorExamWorkbenchDetailDto {
  return {
    ...toExamDto(row),
    reportContent: row.reportContent,
    diagnosis: row.diagnosis,
    hits: row.matches.map(toHitDto),
    // DETAIL_INCLUDE does NOT filter the hits (the drawer must show a filtered
    // hit, annotated), so "has an effective keyword finding" has to be asked of
    // the rows rather than inferred from the array being non-empty.
    attentionSource: toAttentionSource(
      row.matches.some((hit) => !hit.semanticFiltered),
      row.aiAttentionLevel ?? null,
    ),
    aiJudged: toAiJudged(row.reportAiAttempts, row),
    aiSemantics: toAiSemantics(row.reportAiAttempts, row),
  };
}

function toPatientType(code: string | null, name: string | null): MonitorPatientTypeDto {
  return { code, name };
}

function toHitDto(hit: MonitorExamHitRow): MonitorExamHitDto {
  return {
    ruleId: hit.ruleId,
    ruleVersion: hit.rule.version,
    keyword: hit.keyword,
    // The DETERMINISTIC keyword level, untouched by the AI path (issue #87) -
    // the workbench must never imply the model assigned a level.
    level: hit.level,
    matchedField: hit.matchedField,
    contextSnippet: hit.contextSnippet,
    matchedAt: hit.matchedAt.toISOString(),
    semanticFiltered: hit.semanticFiltered,
    semantic: toSemanticDto(hit.semanticJudgements),
  };
}

/**
 * The AI verdict line for one hit (issue #87), or null when there is no
 * successful judgement.
 *
 * Both halves of the verdict must be present before it is shown: a judgement
 * row whose status or confidence is NULL is not a verdict, and rendering it
 * would put words in the model's mouth. The empty case is the common one and
 * is deliberately not an error - it means "this hit stands on the keyword
 * engine's authority alone", which is the pre-#87 behaviour.
 */
function toSemanticDto(judgements: SemanticJudgementRow[]): MonitorHitSemanticDto | null {
  const latest = judgements[0];
  if (!latest || latest.semanticStatus === null || latest.confidence === null) return null;
  return {
    status: latest.semanticStatus,
    confidence: latest.confidence,
    reason: latest.reason,
    judgedAt: latest.createdAt.toISOString(),
  };
}

/**
 * Distinct matched keywords preserving first-appearance order. Input
 * matches are already ordered matchedAt asc, id asc (see the LIST_SELECT
 * in monitor.service.ts), so first appearance == earliest match and a Set
 * iteration keeps that order - no extra sort pass.
 */
function distinctKeywords(matches: { keyword: string }[]): string[] {
  const seen = new Set<string>();
  for (const match of matches) {
    seen.add(match.keyword);
  }
  return Array.from(seen);
}
