/**
 * Stable wire DTOs for the read-only monitor workbench API (issue #7):
 * `GET /api/monitor/exams`, `GET /api/monitor/exams/:id`,
 * `GET /api/monitor/summary`.
 *
 * These mirror the read-only display model converged by issue #26 - there
 * is deliberately NO report/handling/disposition status anywhere in these
 * shapes. The report body (`reportContent`/`diagnosis`) only ever appears
 * in the DETAIL DTO (`MonitorExamDetailDto`); list responses never carry it
 * (see MonitorExamDto). See apps/api/prisma/schema.prisma and
 * docs/data-dictionary.md for the authoritative field-level documentation.
 */

import { MatchFieldDto, MonitorLevelDto } from './rules';

export type { MatchFieldDto, MonitorLevelDto };

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
 * One row of `GET /api/monitor/exams`. Read-only display snapshot - NO
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

/** One hit-evidence row shown in the workbench detail drawer. */
export interface MonitorExamHitDto {
  keyword: string;
  level: MonitorLevelDto;
  matchedField: MatchFieldDto;
  contextSnippet: string;
  /** ISO 8601 UTC instant. */
  matchedAt: string;
}

/**
 * Full snapshot for `GET /api/monitor/exams/:id` (the read-only detail
 * drawer). Extends the list row with the report body (HIGH sensitivity -
 * this is why it is only served on demand, never in the list) and all hits.
 */
export interface MonitorExamDetailDto extends MonitorExamDto {
  reportContent: string | null;
  diagnosis: string | null;
  /** Ordered matchedAt asc, id asc. */
  hits: MonitorExamHitDto[];
}

/** Paginated response envelope for `GET /api/monitor/exams`. */
export interface PaginatedMonitorExams {
  items: MonitorExamDto[];
  total: number;
  page: number;
  pageSize: number;
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
  /** Fuzzy search over patientName OR matched keyword only - NOT report body text. */
  q?: string;
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
