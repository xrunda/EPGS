import { Prisma } from '@prisma/client';
import { MonitorExamDto, MonitorExamWorkbenchDetailDto } from '@epgs/shared-types';

/**
 * Pure helpers for issue #13's data-scope enforcement and patient-data
 * masking. Kept as plain functions (no DI) so they can be unit-tested and
 * reused by services without wiring. See docs/auth.md for the masking rules.
 */

/**
 * Prisma where-clause narrowing a query to the user's authorized departments.
 * Empty scope means all departments (no restriction). Values must exactly
 * match monitor_record.department strings (case-sensitive).
 */
export function buildDepartmentScopeWhere(scope?: string[]): Prisma.MonitorRecordWhereInput {
  if (!scope || scope.length === 0) return {};
  return { department: { in: scope } };
}

/**
 * Masks a patient display name keeping only the family name: 张三 -> 张*,
 * 张三丰 -> 张**, single char -> *, null/blank -> null. The family name is
 * kept deliberately (the workbench needs to disambiguate rows); full names
 * are HIGH-sensitivity (see data dictionary).
 */
export function maskName(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length === 1) return '*';
  return trimmed[0] + '*'.repeat(trimmed.length - 1);
}

/**
 * Masks a list row for a user without patientDetail rights.
 *
 * Generic over the row shape so a caller holding a WIDER row (issue #88's
 * workbench row, which adds `attentionSource`) keeps its type and its extra
 * fields: masking is about patient identity, not about narrowing the DTO to the
 * base type. The alert-link surface's own masking is a separate function on
 * purpose - it keeps bed/department and the report body.
 */
export function maskExamRow<T extends MonitorExamDto>(dto: T): T {
  return {
    ...dto,
    patientName: maskName(dto.patientName),
    bedNo: dto.bedNo ? '***' : null,
  };
}

/**
 * Masks a detail DTO for a user without patientDetail rights: patientName/
 * bedNo are masked as in the list, and the HIGH-sensitivity free text
 * (reportContent / diagnosis / each hit's contextSnippet / each hit's AI
 * explanation / each report-level finding's reason and evidence excerpts) is
 * nulled. The dataAccess.masked flag lets the client distinguish redaction from
 * a report that genuinely has no body.
 */
export function maskExamDetail(
  dto: MonitorExamWorkbenchDetailDto,
): MonitorExamWorkbenchDetailDto {
  return {
    ...maskExamRow(dto),
    reportContent: null,
    diagnosis: null,
    hits: dto.hits.map((hit) => ({
      ...hit,
      contextSnippet: null,
      // Issue #87: the model's explanation is report-adjacent free text - a
      // model asked why it thought a sentence was negative will often quote
      // that sentence - so it is nulled with the rest of the HIGH-sensitivity
      // text. The verdict itself (status/confidence/filtered) is NOT patient
      // data: it describes the keyword rule and the hit, which this caller can
      // already see, so it stays and the drawer can still explain why a hit
      // does not count.
      semantic: hit.semantic ? { ...hit.semantic, reason: null } : null,
    })),
    // Issue #88: same rule as #87 above, applied to the report-level findings.
    // `reason` is the model's own sentence and an excerpt IS report text, so
    // both go. What stays is what explains a level this caller can already see:
    // which configured semantic fired, its configured colour, and how confident
    // the model was - without those, a record with no keyword hit at all would
    // be RED with nothing on screen to account for it.
    //
    // Every excerpt is dropped regardless of its field. An EXAM_ITEM excerpt is
    // only MEDIUM by the dictionary while FINDINGS/IMPRESSION are HIGH, but one
    // finding's array can mix fields, so per-field masking would produce a
    // half-redacted list - and a snippet of the report is the same class of
    // content this function already blankets via contextSnippet.
    //
    // `attentionSource`, `aiJudged` and `aiStatus` need no handling here: they
    // are derived from the level and the queue state this caller already sees,
    // and the generic maskExamRow above preserves them. Issue #102's `aiStatus`
    // in particular MUST survive: it is what tells the doctor the level is
    // keyword-only because the whole-report pass did not complete. Redacting it
    // would take the caveat away from exactly the reader who is least able to
    // check the report for themselves.
    aiSemantics: dto.aiSemantics.map((finding) => ({
      ...finding,
      reason: null,
      evidence: [],
    })),
    // Issue #103: `levelConflicts` survives INTACT, and that is the deliberate
    // call rather than an oversight. It reads as AI-side content, but every one
    // of its five fields is already on this same response to this same caller:
    // `keyword` and `keywordLevel` are the hit row's own keyword and level,
    // `semanticName` and `semanticLevel` are the `aiSemantics` entry's name and
    // attentionLevel (both kept above, for the reason stated there), and `field`
    // is the name of a report column, not text. It carries no excerpt and no
    // offset - the agreement test itself is computed server-side and the
    // evidence never crosses the boundary in either direction.
    //
    // So masking it would not remove a single character of report text; it would
    // only remove the sentence that says "these two things you can see are about
    // the same place and disagree", leaving a reader who cannot open the report
    // with two unexplained colours and no statement that they are related.
    levelConflicts: dto.levelConflicts,
    dataAccess: { masked: true },
  };
}
