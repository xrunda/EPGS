import { Prisma } from '@prisma/client';
import { MonitorExamDetailDto, MonitorExamDto } from '@epgs/shared-types';

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

/** Masks a list row for a user without patientDetail rights. */
export function maskExamRow(dto: MonitorExamDto): MonitorExamDto {
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
 * explanation) is nulled. The dataAccess.masked flag lets the client
 * distinguish redaction from a report that genuinely has no body.
 */
export function maskExamDetail(dto: MonitorExamDetailDto): MonitorExamDetailDto {
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
    dataAccess: { masked: true },
  };
}
