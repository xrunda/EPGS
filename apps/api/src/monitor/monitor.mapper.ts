import { MonitorLevel, MonitorMatch } from '@prisma/client';
import {
  MonitorExamDetailDto,
  MonitorExamDto,
  MonitorExamHitDto,
  MonitorPatientTypeDto,
} from '@epgs/shared-types';
import { formatShanghaiDateTime } from './monitor-time';

/**
 * Maps monitor_record rows to the issue #7/#8 wire DTOs. The list row shape
 * (MonitorExamListRow) deliberately carries ONLY the list-display fields -
 * reportContent/diagnosis never appear in a list query's select, so they
 * cannot leak into the response (they are served only by the detail
 * endpoint via MonitorExamDetailRow). The detail hit rows additionally
 * carry rule provenance (ruleId + the versioned rule's version) per issue
 * #8, so each hit is auditable back to the exact rule that produced it.
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
  matches: { keyword: string; matchedAt: Date }[];
}

/** A detail hit = match row + the versioned rule it references (issue #8). */
export type MonitorExamHitRow = MonitorMatch & { rule: { version: number } };

/** Detail row = list row + report body snapshot + full hit rows. */
export interface MonitorExamDetailRow extends MonitorExamListRow {
  reportContent: string | null;
  diagnosis: string | null;
  matches: MonitorExamHitRow[];
}

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

export function toExamDetailDto(row: MonitorExamDetailRow): MonitorExamDetailDto {
  return {
    ...toExamDto(row),
    reportContent: row.reportContent,
    diagnosis: row.diagnosis,
    hits: row.matches.map(toHitDto),
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
    level: hit.level,
    matchedField: hit.matchedField,
    contextSnippet: hit.contextSnippet,
    matchedAt: hit.matchedAt.toISOString(),
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
