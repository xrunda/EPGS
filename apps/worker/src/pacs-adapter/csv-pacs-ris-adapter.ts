import { readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { FetchReportsParams, FetchReportsResult, PacsReportDto } from '@epgs/shared-types';
import { parse } from 'csv-parse/sync';
import { mapWireReportToDto } from './http-pacs-ris-adapter';
import { PacsRisAdapter } from './pacs-ris-adapter.interface';

const MAX_PAGE_SIZE = 500;

export const MOCK_CSV_COLUMNS = [
  'sourceRecordId',
  'patientRegistrationNo',
  'patientName',
  'department',
  'bedNo',
  'patientTypeCode',
  'patientTypeName',
  'examItem',
  'examDate',
  'examTime',
  'reportContent',
  'diagnosis',
] as const;

interface CsvPacsRisAdapterOptions {
  filePath?: string;
  csvText?: string;
}

function validateColumns(columns: string[]): string[] {
  for (const required of MOCK_CSV_COLUMNS) {
    if (!columns.includes(required)) {
      throw new Error(`Mock CSV missing required column: ${required}`);
    }
  }
  return columns;
}

function emptyAsNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** Parse API-shaped CSV through the exact same mapper used by the HTTP adapter. */
export function parseCsvReports(csvText: string): PacsReportDto[] {
  const rows = parse(csvText, {
    bom: true,
    columns: validateColumns,
    skip_empty_lines: true,
  }) as Array<Record<string, string>>;

  const seen = new Set<string>();
  return rows.map((row, index) => {
    const wireRecord = {
      sourceRecordId: row.sourceRecordId,
      patientRegistrationNo: emptyAsNull(row.patientRegistrationNo),
      patientName: emptyAsNull(row.patientName),
      department: emptyAsNull(row.department),
      bedNo: emptyAsNull(row.bedNo),
      patientTypeCode: emptyAsNull(row.patientTypeCode),
      patientTypeName: emptyAsNull(row.patientTypeName),
      examItem: emptyAsNull(row.examItem),
      examDate: row.examDate,
      examTime: emptyAsNull(row.examTime),
      reportContent: emptyAsNull(row.reportContent),
      diagnosis: emptyAsNull(row.diagnosis),
    };

    let dto: PacsReportDto;
    try {
      dto = mapWireReportToDto(wireRecord);
    } catch {
      throw new Error(`Mock CSV row ${index + 2} violates the PACS/RIS API contract`);
    }
    if (seen.has(dto.sourceRecordId)) {
      throw new Error(`Mock CSV duplicate sourceRecordId: ${dto.sourceRecordId}`);
    }
    seen.add(dto.sourceRecordId);
    return dto;
  });
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw new Error('fetchReports: invalid cursor');
  return Number(match[1]);
}

/** Local-only adapter for an API-shaped, synthetic UTF-8 CSV export. */
@Injectable()
export class CsvPacsRisAdapter implements PacsRisAdapter {
  private readonly logger = new Logger(CsvPacsRisAdapter.name);
  private readonly records: PacsReportDto[];

  constructor(options: CsvPacsRisAdapterOptions) {
    let csvText = options.csvText;
    if (csvText === undefined && options.filePath) {
      try {
        csvText = readFileSync(options.filePath, 'utf8');
      } catch {
        throw new Error('Cannot read mock CSV; check PACS_MOCK_CSV_PATH');
      }
    }
    if (csvText === undefined) {
      throw new Error('CSV adapter requires PACS_MOCK_CSV_PATH');
    }
    this.records = parseCsvReports(csvText);
    this.logger.log(`CsvPacsRisAdapter loaded ${this.records.length} synthetic record(s)`);
  }

  async fetchReports(params: FetchReportsParams): Promise<FetchReportsResult> {
    if (!params.since) throw new Error('fetchReports: params.since is required');
    if (!params.pageSize || params.pageSize <= 0) {
      throw new Error('fetchReports: params.pageSize must be a positive integer');
    }
    if (params.deviceId) {
      throw new Error('fetchReports: deviceId is not available in the confirmed API contract');
    }

    const until = params.until ?? new Date();
    const pageSize = Math.min(params.pageSize, MAX_PAGE_SIZE);
    const offset = decodeCursor(params.cursor);
    const filtered = this.records
      .filter((record) => record.examTime >= params.since && record.examTime < until)
      .filter((record) => !params.department || record.department === params.department)
      .sort((left, right) => {
        const timeDifference = left.examTime.getTime() - right.examTime.getTime();
        return timeDifference || left.sourceRecordId.localeCompare(right.sourceRecordId);
      });
    const items = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;

    return {
      items,
      nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset) : undefined,
    };
  }
}
