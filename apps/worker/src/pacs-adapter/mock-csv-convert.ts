/**
 * Local-only helper for the hospital-provided mock export (`Doc/moke‑data.csv`,
 * issue #42). The raw file the hospital sent is GB18030/GBK-encoded, uses 11
 * Chinese column headers, and its filename contains a U+2011 non-breaking
 * hyphen - none of which satisfy the CSV adapter's contract (UTF-8 + the 12
 * English wire columns of docs/api/pacs-ris-data-api.md). This entry converts
 * it to `Doc/moke-data.utf8.csv`, which `pnpm dev` reads through the normal
 * PACS_MOCK_CSV_PATH default.
 *
 * The raw file and its conversion output contain likely-real patient data and
 * are both git-ignored (`Doc/moke*`). This script never prints row contents -
 * it reports counts only. Tests use synthetic text, never the real file.
 *
 * Run from the repo root:
 *
 *   pnpm --filter worker run mock:convert [--input <path>] [--output <path>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parse } from 'csv-parse/sync';
import { parseCsvReports } from './csv-pacs-ris-adapter';

/** Source header row of the hospital export, in file order. */
export const MOCK_CSV_SOURCE_HEADERS = [
  '检查号',
  '登记号',
  '姓名',
  '科室',
  '床号',
  '类型',
  '检查项目',
  '检查日期',
  '检查时间',
  '报告内容',
  '诊断',
] as const;

/**
 * Target header row the CSV adapter accepts (docs/api/pacs-ris-data-api.md).
 * Index-aligned with the source columns except that `patientTypeName`
 * (derived from 类型) is inserted right after `patientTypeCode`.
 */
export const MOCK_CSV_TARGET_HEADERS = [
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

/** Patient-type dictionary from docs/acceptance.md: I -> 住院, O -> 门诊. */
const PATIENT_TYPE_NAME: Record<string, string> = { I: '住院', O: '门诊' };

const DEFAULT_SOURCE_PATH = resolve(__dirname, '../../../../Doc/moke‑data.csv');
const FALLBACK_SOURCE_PATH = resolve(__dirname, '../../../../Doc/moke-data.csv');
const DEFAULT_OUTPUT_PATH = resolve(__dirname, '../../../../Doc/moke-data.utf8.csv');

/**
 * Normalizes the export's date cell (`2026-8-2 0:00`, an Excel artifact that
 * embeds a `0:00` time) to the adapter's strict `YYYY-MM-DD`. Values that
 * already conform, or are malformed, are passed through unchanged so the
 * adapter's own contract check reports the bad row instead of us silently
 * guessing.
 */
export function normalizeMockExamDate(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(trimmed);
  if (!match) return trimmed;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

/**
 * Normalizes the export's time cell (`8:48:08`) to the adapter's strict
 * `HH:mm:ss[.fraction]`. Malformed values pass through unchanged.
 */
export function normalizeMockExamTime(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)(\.\d+)?$/.exec(trimmed);
  if (!match) return trimmed;
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3]}${match[4] ?? ''}`;
}

/**
 * Maps the export's 类型 cell onto (patientTypeCode, patientTypeName).
 * Known codes (I/O) keep the code and gain the dictionary label; an unknown
 * Chinese label (e.g. 住院) is kept as the display name with an empty code so
 * the dictionary's "unknown code -> NULL" rule still holds; other unknown
 * values keep the code with an empty name.
 */
export function derivePatientType(value: string): { code: string; name: string } {
  const trimmed = value.trim();
  if (!trimmed) return { code: '', name: '' };
  const known = PATIENT_TYPE_NAME[trimmed];
  if (known) return { code: trimmed, name: known };
  if (/[\u4e00-\u9fff]/.test(trimmed)) return { code: '', name: trimmed };
  return { code: trimmed, name: '' };
}

/** RFC 4180 cell escaping - quotes cells containing a delimiter, quote, or newline. */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export interface MockCsvConversionResult {
  /** UTF-8 CSV text with the 12 English wire headers. */
  csv: string;
  /** Number of data rows converted (header excluded). */
  dataRowCount: number;
}

/**
 * Converts decoded (UTF-8) Chinese-header mock CSV text into the adapter's
 * English-header wire format. The result is not yet contract-validated here -
 * the CLI runs it through `parseCsvReports` so a bad row fails loudly with
 * the row number, mirroring what the adapter would do at sync time.
 */
export function convertMockCsv(text: string): MockCsvConversionResult {
  const rows = parse(text, { bom: true, skip_empty_lines: true }) as string[][];
  if (rows.length === 0) {
    throw new Error('Mock CSV is empty - expected a header row');
  }
  const header = rows[0].map((cell) => cell.trim());
  for (let i = 0; i < MOCK_CSV_SOURCE_HEADERS.length; i += 1) {
    if (header[i] !== MOCK_CSV_SOURCE_HEADERS[i]) {
      throw new Error(
        `Mock CSV header mismatch at column ${i + 1}: ` +
          `expected "${MOCK_CSV_SOURCE_HEADERS[i]}", got "${header[i] ?? ''}"`,
      );
    }
  }

  const lines = [MOCK_CSV_TARGET_HEADERS.join(',')];
  for (const row of rows.slice(1)) {
    const get = (index: number): string => row[index]?.trim() ?? '';
    const patientType = derivePatientType(get(5));
    const cells = [
      get(0), // sourceRecordId
      get(1), // patientRegistrationNo
      get(2), // patientName
      get(3), // department
      get(4), // bedNo
      patientType.code, // patientTypeCode
      patientType.name, // patientTypeName
      get(6), // examItem
      normalizeMockExamDate(get(7)), // examDate
      normalizeMockExamTime(get(8)), // examTime
      get(9), // reportContent
      get(10), // diagnosis
    ];
    lines.push(cells.map(escapeCsvCell).join(','));
  }
  return { csv: lines.join('\n'), dataRowCount: rows.length - 1 };
}

/** Decodes a GB18030/GBK buffer (the hospital export's encoding) to UTF-8 text. */
export function decodeGb18030(buffer: Buffer): string {
  return new TextDecoder('gb18030').decode(buffer);
}

function readArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const sourcePath =
    readArg(args, '--input') ??
    (existsSync(DEFAULT_SOURCE_PATH) ? DEFAULT_SOURCE_PATH : FALLBACK_SOURCE_PATH);
  const outputPath = readArg(args, '--output') ?? DEFAULT_OUTPUT_PATH;

  if (!existsSync(sourcePath)) {
    // eslint-disable-next-line no-console
    console.error(
      `mock:convert: source CSV not found (tried ${DEFAULT_SOURCE_PATH} and ${FALLBACK_SOURCE_PATH}); ` +
        'put the hospital export at either path or pass --input <path>',
    );
    process.exitCode = 1;
    return;
  }

  const text = decodeGb18030(readFileSync(sourcePath));
  const { csv, dataRowCount } = convertMockCsv(text);
  // Contract-check the output exactly as the CSV adapter will at sync time.
  parseCsvReports(csv);
  // Leading BOM keeps Excel/Notepad from misreading the UTF-8 output; the
  // adapter's csv-parse strips it (bom: true).
  writeFileSync(outputPath, '\uFEFF' + csv, 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `mock:convert: ${dataRowCount} data row(s) -> ${outputPath} ` +
      '(validated against the PACS/RIS CSV contract; raw file left untouched)',
  );
}

if (require.main === module) {
  main();
}
