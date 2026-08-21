import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { FetchReportsParams, FetchReportsResult, PacsReportDto } from '@epgs/shared-types';
import { PacsRisAdapter } from './pacs-ris-adapter.interface';

/** Hard ceiling on page size so no caller can force an unbounded scan. */
export const MAX_PAGE_SIZE = 500;

/**
 * Minimal shape of a parameterized query executor this adapter depends
 * on, so it can be unit-tested without a real database driver and so
 * the concrete driver (mssql / node-postgres / TypeORM QueryRunner /
 * Prisma $queryRaw, etc.) is swappable.
 *
 * IMPLEMENTORS MUST use parameter binding (e.g. mssql's `request.input`)
 * and MUST NOT string-concatenate values into `sql`. `params` values are
 * always passed positionally/by-name to the driver, never interpolated.
 */
export interface ParameterizedQueryExecutor {
  /**
   * Executes `sql` with bound `params` and returns raw rows. `sql` must
   * be a static (non-dynamically-built-from-user-input) string owned by
   * this adapter; only `params` values vary per call.
   */
  query<TRow = Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<TRow[]>;
}

export const PACS_SQL_EXECUTOR = Symbol('PACS_SQL_EXECUTOR');

/**
 * Raw row shape this adapter expects back from the query in
 * `buildFetchReportsQuery`. Column names are ASSUMED (not verified
 * against a production PACS/RIS database) - see
 * docs/pacs-ris-adapter.md "待生产环境核验" for the full list of
 * assumptions that need confirmation before this adapter is pointed at
 * a real database.
 *
 * Converged to the read-only display field set (issue #26): no workflow/
 * review status, no sex/age/inpatient number. SOURCE_RECORD_ID,
 * REPORT_ID and SOURCE_UPDATED_AT are the sync idempotency/change-detection
 * key (internal bookkeeping, not displayed).
 */
interface PacsRawRow {
  SOURCE_RECORD_ID: string;
  PATIENT_NAME: string;
  DEPARTMENT_NAME: string | null;
  BED_NO: string | null;
  PATIENT_TYPE_CODE: string | null;
  PATIENT_TYPE_NAME: string | null;
  EXAM_ITEM: string;
  EXAM_TIME: Date | string;
  REPORT_ID: string;
  REPORT_CONTENT: string | null;
  DIAGNOSIS: string | null;
  SOURCE_UPDATED_AT: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDto(row: PacsRawRow): PacsReportDto {
  return {
    sourceRecordId: row.SOURCE_RECORD_ID,
    patientName: row.PATIENT_NAME,
    department: row.DEPARTMENT_NAME,
    bedNo: row.BED_NO,
    patientTypeCode: row.PATIENT_TYPE_CODE,
    patientTypeName: row.PATIENT_TYPE_NAME,
    examItem: row.EXAM_ITEM,
    examTime: toDate(row.EXAM_TIME),
    reportId: row.REPORT_ID,
    reportContent: row.REPORT_CONTENT,
    diagnosis: row.DIAGNOSIS,
    sourceUpdatedAt: toDate(row.SOURCE_UPDATED_AT),
  };
}

/**
 * Builds the static, parameterized SQL text + bound params for one
 * fetchReports() call. Exported standalone (not just inlined in the
 * class) so unit tests can assert the query is always time-bounded,
 * page-size-bounded, and free of string-concatenated values without
 * needing a live database.
 *
 * Schema assumptions (ALL require production verification - see
 * docs/pacs-ris-adapter.md):
 * - Table names: PATIENTINFO, STUDYINFO, REPORTINFO, REPORTCONTENT, LOC.
 * - Join keys: STUDYINFO.ST_ACCNUM = REPORTINFO.ST_ACCNUM =
 *   REPORTCONTENT.ST_ACCNUM; STUDYINFO.PAT_ID = PATIENTINFO.PAT_ID.
 * - A `SOURCE_UPDATED_AT`-equivalent column exists (or is computed as
 *   MAX of several timestamp columns) to drive incremental sync; the
 *   assumed candidate is REPORTINFO's last-modified column, falling
 *   back to REPORTCONTENT's, falling back to STUDYINFO's.
 * - SQL Server dialect (`OFFSET/FETCH` keyset-friendly pagination via
 *   `TOP` + a `(SOURCE_UPDATED_AT, REPORT_ID) > (@cursorTs, @cursorId)`
 *   predicate). If the target is not SQL Server, replace this query
 *   builder's dialect-specific clauses (`TOP`, bracket identifiers)
 *   with the target driver's equivalent - the shape of bound params
 *   and the join/ordering logic stay the same.
 */
export function buildFetchReportsQuery(params: FetchReportsParams): {
  sql: string;
  boundParams: Record<string, unknown>;
} {
  if (!params.since) {
    throw new Error('buildFetchReportsQuery: params.since is required');
  }
  const pageSize = Math.min(Math.max(1, params.pageSize || 0), MAX_PAGE_SIZE);
  const until = params.until ?? new Date();
  const cursor = decodeKeysetCursor(params.cursor);

  const boundParams: Record<string, unknown> = {
    since: params.since,
    until,
    pageSize,
  };

  const filters: string[] = ['r.SOURCE_UPDATED_AT >= @since', 'r.SOURCE_UPDATED_AT < @until'];

  if (params.department) {
    filters.push('loc.DEPARTMENT_NAME = @department');
    boundParams.department = params.department;
  }
  if (params.deviceId) {
    filters.push('s.DEVICE_ID = @deviceId');
    boundParams.deviceId = params.deviceId;
  }
  if (cursor) {
    filters.push(
      '(r.SOURCE_UPDATED_AT > @cursorTs OR (r.SOURCE_UPDATED_AT = @cursorTs AND r.REPORT_ID > @cursorId))',
    );
    boundParams.cursorTs = cursor.ts;
    boundParams.cursorId = cursor.id;
  }

  // NOTE: every value above is bound via @paramName placeholders and
  // passed through boundParams - nothing user-controlled is
  // concatenated into the SQL string itself.
  const sql = `
    SELECT TOP (@pageSize)
      s.ST_ACCNUM         AS SOURCE_RECORD_ID,
      p.PATIENT_NAME      AS PATIENT_NAME,
      loc.DEPARTMENT_NAME AS DEPARTMENT_NAME,
      s.BED_NO            AS BED_NO,
      p.PATIENT_TYPE_CODE AS PATIENT_TYPE_CODE,
      p.PATIENT_TYPE_NAME AS PATIENT_TYPE_NAME,
      s.EXAM_ITEM         AS EXAM_ITEM,
      s.EXAM_TIME         AS EXAM_TIME,
      r.REPORT_ID         AS REPORT_ID,
      rc.RPT_DESCRIBE     AS REPORT_CONTENT,
      rc.RPT_DIAGNOSE     AS DIAGNOSIS,
      r.SOURCE_UPDATED_AT AS SOURCE_UPDATED_AT
    FROM STUDYINFO s
      INNER JOIN PATIENTINFO p ON s.PAT_ID = p.PAT_ID
      INNER JOIN REPORTINFO r ON r.ST_ACCNUM = s.ST_ACCNUM
      LEFT JOIN REPORTCONTENT rc ON rc.ST_ACCNUM = s.ST_ACCNUM AND rc.REPORT_ID = r.REPORT_ID
      LEFT JOIN LOC loc ON loc.LOC_ID = s.LOC_ID
    WHERE ${filters.join(' AND ')}
    ORDER BY r.SOURCE_UPDATED_AT ASC, r.REPORT_ID ASC
  `.trim();

  return { sql, boundParams };
}

function encodeKeysetCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.toISOString()}|${id}`, 'utf8').toString('base64');
}

function decodeKeysetCursor(cursor: string | undefined): { ts: Date; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const [tsRaw, id] = decoded.split('|');
  if (!tsRaw || !id) {
    throw new Error(`fetchReports: invalid cursor "${cursor}"`);
  }
  return { ts: new Date(tsRaw), id };
}

/**
 * SQL-backed PacsRisAdapter skeleton, intended for a read-only SQL
 * Server PACS/RIS database (see docs/pacs-ris-adapter.md for the
 * dialect assumption and how to adapt to another RDBMS). This
 * implementation is NOT connected to any real database by this issue -
 * it depends on an injected `ParameterizedQueryExecutor` so the SQL
 * template, param binding, and row-mapping logic can be fully unit
 * tested without a live connection. Issue #24 owns the real IRIS/Caché
 * adapter rewrite.
 *
 * Access model (design intent, enforced operationally not in code):
 * the DB user configured via PACS_DB_* env vars must be a dedicated
 * read-only account with SELECT-only grants on the source tables - see
 * docs/pacs-ris-adapter.md.
 */
@Injectable()
export class SqlPacsRisAdapter implements PacsRisAdapter {
  private readonly logger = new Logger(SqlPacsRisAdapter.name);

  constructor(
    @Optional() @Inject(PACS_SQL_EXECUTOR) private readonly executor?: ParameterizedQueryExecutor,
  ) {}

  async fetchReports(params: FetchReportsParams): Promise<FetchReportsResult> {
    if (!this.executor) {
      throw new Error(
        'SqlPacsRisAdapter has no ParameterizedQueryExecutor configured. ' +
          'Set PACS_ADAPTER_MODE=fixture for local/dev/test, or provide a ' +
          'PACS_SQL_EXECUTOR implementation for a real PACS/RIS connection.',
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

    const rows = await this.executor.query<PacsRawRow>(sql, boundParams);
    const items = rows.map(toDto);

    let nextCursor: string | undefined;
    if (items.length === requestedPageSize) {
      const last = items[items.length - 1];
      nextCursor = encodeKeysetCursor(last.sourceUpdatedAt, last.reportId);
    }

    return { items, nextCursor };
  }
}
