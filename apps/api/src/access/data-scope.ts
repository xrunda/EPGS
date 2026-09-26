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
    // `attentionSource` and `aiJudged` need no handling here: they are derived
    // from the level this caller already sees, and the generic maskExamRow above
    // preserves them.
    aiSemantics: dto.aiSemantics.map((finding) => ({
      ...finding,
      reason: null,
      evidence: [],
    })),
    dataAccess: { masked: true },
  };
}
