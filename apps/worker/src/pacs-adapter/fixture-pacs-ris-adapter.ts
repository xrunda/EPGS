import { Injectable, Logger } from '@nestjs/common';
import {
  FetchReportsParams,
  FetchReportsResult,
  PacsPatientSex,
  PacsReportDto,
} from '@epgs/shared-types';
import { PacsRisAdapter } from './pacs-ris-adapter.interface';
import { mapRawStatus } from './status-mapping';
import rawFixture from './fixtures/reports.fixture.json';

/** Hard ceiling on page size, mirrored from SqlPacsRisAdapter's LIMIT/TOP guard. */
const MAX_PAGE_SIZE = 500;

interface FixtureRecord {
  patientId: string;
  inpatientNo: string | null;
  patientName: string;
  sex: PacsPatientSex;
  age: number | null;
  department: string | null;
  bedNo: string | null;
  studyAccessionNo: string;
  examItem: string;
  examTime: string;
  reportId: string;
  reportStatusRaw: string | null;
  reportSavedAt: string | null;
  reportSubmittedAt: string | null;
  reportReviewedAt: string | null;
  describeText: string | null;
  diagnoseText: string | null;
  sourceUpdatedAt: string;
}

function toDate(value: string): Date {
  return new Date(value);
}

function toNullableDate(value: string | null): Date | null {
  return value == null ? null : new Date(value);
}

function toDto(record: FixtureRecord): PacsReportDto {
  const examTimestamp = toDate(record.examTime);
  return {
    sourceRecordId: record.reportId,
    patientRegistrationNo: record.inpatientNo ?? record.patientId,
    patientTypeCode: record.inpatientNo == null ? 'O' : 'I',
    patientTypeName: null,
    examDate: record.examTime.slice(0, 10),
    examTimeText: record.examTime.slice(11, 19),
    reportContent: record.describeText,
    diagnosis: record.diagnoseText,
    patientId: record.patientId,
    inpatientNo: record.inpatientNo,
    patientName: record.patientName,
    sex: record.sex,
    age: record.age,
    department: record.department,
    bedNo: record.bedNo,
    studyAccessionNo: record.studyAccessionNo,
    examItem: record.examItem,
    examTime: examTimestamp,
    reportId: record.reportId,
    reportStatus: mapRawStatus(record.reportStatusRaw),
    rawStatusCode: record.reportStatusRaw,
    reportSavedAt: toNullableDate(record.reportSavedAt),
    reportSubmittedAt: toNullableDate(record.reportSubmittedAt),
    reportReviewedAt: toNullableDate(record.reportReviewedAt),
    describeText: record.describeText,
    diagnoseText: record.diagnoseText,
    sourceUpdatedAt: toDate(record.sourceUpdatedAt),
  };
}

/**
 * In-memory PacsRisAdapter backed by a synthetic fixture dataset (see
 * ./fixtures/reports.fixture.json). Used as the default implementation
 * for local development, unit tests, and CI - no real database
 * connection required.
 *
 * Behavioral notes (mirrors SqlPacsRisAdapter's documented contract):
 * - Returns ALL report rows/versions in range, not just the latest
 *   version per accession number. Multiple REPORTINFO rows sharing the
 *   same studyAccessionNo (report re-saves/revisions) are surfaced as
 *   separate PacsReportDto items; callers (issue #6 sync job) decide
 *   how to reconcile versions using `reportId` + `sourceUpdatedAt`. The
 *   adapter does not silently drop older versions - that would lose
 *   information about what a clinician actually saw at each point.
 * - Ordering is deterministic: sourceUpdatedAt ascending, then
 *   reportId ascending as a tiebreaker - required for stable
 *   cursor-based pagination.
 * - Duplicate accession numbers across different patients/studies (a
 *   source data-quality edge case) are passed through as-is; the
 *   adapter does not attempt to deduplicate or merge them since it has
 *   no reliable way to know which is authoritative.
 */
@Injectable()
export class FixturePacsRisAdapter implements PacsRisAdapter {
  private readonly logger = new Logger(FixturePacsRisAdapter.name);
  private readonly records: FixtureRecord[];

  constructor(records?: FixtureRecord[]) {
    this.records = records ?? (rawFixture as { records: FixtureRecord[] }).records ?? [];
    this.logger.log(`FixturePacsRisAdapter loaded with ${this.records.length} record(s)`);
  }

  async fetchReports(params: FetchReportsParams): Promise<FetchReportsResult> {
    if (!params.since) {
      throw new Error('fetchReports: params.since is required');
    }
    if (!params.pageSize || params.pageSize <= 0) {
      throw new Error('fetchReports: params.pageSize must be a positive integer');
    }
    const pageSize = Math.min(params.pageSize, MAX_PAGE_SIZE);
    const until = params.until ?? new Date();

    let filtered = this.records
      .map(toDto)
      .filter((dto) => dto.sourceUpdatedAt >= params.since && dto.sourceUpdatedAt < until);

    if (params.department) {
      filtered = filtered.filter((dto) => dto.department === params.department);
    }

    // Deterministic ordering: sourceUpdatedAt asc, reportId asc tiebreak.
    filtered.sort((a, b) => {
      const diff = a.sourceUpdatedAt.getTime() - b.sourceUpdatedAt.getTime();
      if (diff !== 0) return diff;
      return a.reportId.localeCompare(b.reportId);
    });

    const cursorIndex = decodeCursor(params.cursor);
    const startIndex = cursorIndex == null ? 0 : cursorIndex;
    const page = filtered.slice(startIndex, startIndex + pageSize);
    const nextIndex = startIndex + pageSize;
    const nextCursor = nextIndex < filtered.length ? encodeCursor(nextIndex) : undefined;

    return { items: page, nextCursor };
  }
}

/**
 * Cursor is an opaque base64-encoded offset into the deterministically
 * sorted result set. This is sufficient for a fixture/mock adapter;
 * SqlPacsRisAdapter uses a keyset cursor (sourceUpdatedAt, reportId)
 * instead of an offset, since offsets are unsafe against a live,
 * mutating source table (see docs/pacs-ris-adapter.md).
 */
function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) {
    throw new Error(`fetchReports: invalid cursor "${cursor}"`);
  }
  return parseInt(match[1], 10);
}
