import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  FetchReportsParams,
  FetchReportsResult,
  PacsReportDto,
  PacsReportStatus,
} from '@epgs/shared-types';
import { PacsRisAdapter } from './pacs-ris-adapter.interface';

/** Hard ceiling on page size so no caller can force an unbounded scan. */
export const MAX_PAGE_SIZE = 500;

/** Driver-neutral positional parameter executor for InterSystems IRIS SQL. */
export interface ParameterizedQueryExecutor {
  query<TRow = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<TRow[]>;
}

export const PACS_SQL_EXECUTOR = Symbol('PACS_SQL_EXECUTOR');

interface IrisReportRow {
  SOURCE_RECORD_ID: string | null;
  PATIENT_REGISTRATION_NO: string | null;
  PATIENT_NAME: string | null;
  DEPARTMENT: string | null;
  BED_NO: string | null;
  PATIENT_TYPE_CODE: string | null;
  EXAM_ITEM: string | null;
  EXAM_DATE: Date | string;
  EXAM_TIME: Date | string | null;
  REPORT_CONTENT: string | null;
  DIAGNOSIS: string | null;
}

interface IrisCursor {
  date: string;
  time: string;
  id: string;
}

function dateText(value: Date | string): string {
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (match) return match[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid RISR_ReportDate value: ${String(value)}`);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function timeText(value: Date | string | null): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const match = /(?:T|^)(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(value);
    if (match) return match[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid RISR_ReportTime value: ${String(value)}`);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function reportTimestamp(examDate: string, examTime: string | null): Date {
  return new Date(`${examDate}T${examTime ?? '00:00:00'}+08:00`);
}

function requiredText(value: string | null, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function toDto(row: IrisReportRow): PacsReportDto {
  const sourceRecordId = requiredText(row.SOURCE_RECORD_ID, 'RISR_ExamID');
  const patientRegistrationNo = row.PATIENT_REGISTRATION_NO?.trim() || null;
  const examDate = dateText(row.EXAM_DATE);
  const examTimeText = timeText(row.EXAM_TIME);
  const sourceUpdatedAt = reportTimestamp(examDate, examTimeText);

  return {
    sourceRecordId,
    patientRegistrationNo,
    patientTypeCode: row.PATIENT_TYPE_CODE,
    patientTypeName: null,
    examDate,
    examTimeText,
    reportContent: row.REPORT_CONTENT,
    diagnosis: row.DIAGNOSIS,
    patientId: patientRegistrationNo ?? '',
    inpatientNo: null,
    patientName: row.PATIENT_NAME,
    sex: 'UNKNOWN',
    age: null,
    department: row.DEPARTMENT,
    bedNo: row.BED_NO,
    studyAccessionNo: sourceRecordId,
    examItem: row.EXAM_ITEM,
    examTime: sourceUpdatedAt,
    reportId: sourceRecordId,
    reportStatus: PacsReportStatus.UNKNOWN,
    rawStatusCode: null,
    reportSavedAt: null,
    reportSubmittedAt: null,
    reportReviewedAt: null,
    describeText: row.REPORT_CONTENT,
    diagnoseText: row.DIAGNOSIS,
    sourceUpdatedAt,
  };
}

/** Build a bounded, parameterized InterSystems IRIS/Caché query. */
export function buildFetchReportsQuery(params: FetchReportsParams): {
  sql: string;
  boundParams: readonly unknown[];
} {
  if (!params.since) throw new Error('buildFetchReportsQuery: params.since is required');
  if (params.deviceId)
    throw new Error(
      'buildFetchReportsQuery: deviceId is not available in the confirmed IRIS schema',
    );

  const pageSize = Math.min(Math.max(1, params.pageSize || 0), MAX_PAGE_SIZE);
  const until = params.until ?? new Date();
  const cursor = decodeCursor(params.cursor);
  const sinceDate = dateText(params.since);
  const sinceTime = timeText(params.since) ?? '00:00:00';
  const untilDate = dateText(until);
  const untilTime = timeText(until) ?? '00:00:00';
  const filters = [
    "(a.RISR_ReportDate > ? OR (a.RISR_ReportDate = ? AND COALESCE(a.RISR_ReportTime, '00:00:00') >= ?))",
    "(a.RISR_ReportDate < ? OR (a.RISR_ReportDate = ? AND COALESCE(a.RISR_ReportTime, '00:00:00') < ?))",
    'a.RISR_SysCode = ?',
  ];
  const boundParams: unknown[] = [
    pageSize,
    sinceDate,
    sinceDate,
    sinceTime,
    untilDate,
    untilDate,
    untilTime,
    'ES',
  ];

  if (params.department) {
    filters.push('pa.PAADM_DepCode_DR->CTLOC_Desc = ?');
    boundParams.push(params.department);
  }
  if (cursor) {
    filters.push(
      "(a.RISR_ReportDate > ? OR (a.RISR_ReportDate = ? AND (COALESCE(a.RISR_ReportTime, '00:00:00') > ? OR (COALESCE(a.RISR_ReportTime, '00:00:00') = ? AND a.RISR_ExamID > ?))))",
    );
    boundParams.push(cursor.date, cursor.date, cursor.time, cursor.time, cursor.id);
  }

  const sql = `
    SELECT TOP ?
      a.RISR_ExamID AS SOURCE_RECORD_ID,
      pp.PAPMI_No AS PATIENT_REGISTRATION_NO,
      pp.PAPMI_Name AS PATIENT_NAME,
      pa.PAADM_DepCode_DR->CTLOC_Desc AS DEPARTMENT,
      pa.PAADM_CurrentBed_DR->BED_Code AS BED_NO,
      pa.PAADM_Type AS PATIENT_TYPE_CODE,
      a.RISR_ItemDesc AS EXAM_ITEM,
      a.RISR_ReportDate AS EXAM_DATE,
      a.RISR_ReportTime AS EXAM_TIME,
      a.RISR_ExamDesc AS REPORT_CONTENT,
      a.RISR_DiagDesc AS DIAGNOSIS
    FROM Ens_RISReportResult a
      LEFT JOIN PA_Adm pa ON pa.PAADM_RowID = a.RISR_VisitNumber
      LEFT JOIN PA_PatMas pp ON a.RISR_PatientID = pp.PAPMI_RowId1
    WHERE ${filters.join(' AND ')}
    ORDER BY a.RISR_ReportDate ASC, COALESCE(a.RISR_ReportTime, '00:00:00') ASC, a.RISR_ExamID ASC
  `.trim();

  return { sql, boundParams };
}

function encodeCursor(item: PacsReportDto): string {
  return Buffer.from(
    JSON.stringify({
      date: item.examDate,
      time: item.examTimeText ?? '00:00:00',
      id: item.sourceRecordId,
    }),
    'utf8',
  ).toString('base64');
}

function decodeCursor(cursor: string | undefined): IrisCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as IrisCursor;
    if (!decoded.date || !decoded.time || !decoded.id) throw new Error('missing fields');
    return decoded;
  } catch {
    throw new Error(`fetchReports: invalid cursor "${cursor}"`);
  }
}

@Injectable()
export class SqlPacsRisAdapter implements PacsRisAdapter {
  private readonly logger = new Logger(SqlPacsRisAdapter.name);

  constructor(
    @Optional() @Inject(PACS_SQL_EXECUTOR) private readonly executor?: ParameterizedQueryExecutor,
  ) {}

  async fetchReports(params: FetchReportsParams): Promise<FetchReportsResult> {
    if (!this.executor) {
      throw new Error(
        'SqlPacsRisAdapter has no ParameterizedQueryExecutor configured. Set PACS_ADAPTER_MODE=fixture for local/dev/test, or provide a PACS_SQL_EXECUTOR implementation.',
      );
    }
    if (!params.pageSize || params.pageSize <= 0) {
      throw new Error('fetchReports: params.pageSize must be a positive integer');
    }

    const { sql, boundParams } = buildFetchReportsQuery(params);
    const requestedPageSize = Math.min(params.pageSize, MAX_PAGE_SIZE);
    this.logger.debug(
      `fetchReports since=${params.since.toISOString()} until=${(params.until ?? new Date()).toISOString()} pageSize=${requestedPageSize}`,
    );

    const rows = await this.executor.query<IrisReportRow>(sql, boundParams);
    const items = rows.map(toDto);
    const nextCursor =
      items.length === requestedPageSize ? encodeCursor(items[items.length - 1]) : undefined;
    return { items, nextCursor };
  }
}
