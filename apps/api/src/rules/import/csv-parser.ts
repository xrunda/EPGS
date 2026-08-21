import { parse } from 'csv-parse/sync';

/**
 * Expected CSV header (order-independent, matched case-insensitively).
 * `matchMode` and `category`/`notes` are optional columns.
 */
export const REQUIRED_COLUMNS = ['keyword', 'level', 'matchField'] as const;
export const OPTIONAL_COLUMNS = ['matchMode', 'category', 'notes'] as const;

export interface RawImportRow {
  line: number;
  keyword: string;
  level: string;
  matchField: string;
  matchMode?: string;
  category?: string;
  notes?: string;
}

export interface CsvParseOutcome {
  rows: RawImportRow[];
  /** Fatal parse-level errors (bad encoding, malformed CSV, missing required column). Import cannot proceed. */
  fatalError?: string;
}

/**
 * Parses CSV bytes into raw import rows. Deliberately permissive at this
 * layer (only structural/encoding failures are fatal) - business-rule
 * validation (blank keyword, invalid enum, duplicates, conflicts) happens
 * one layer up in RulesImportService so each bad row can be reported
 * individually rather than aborting the whole file.
 *
 * Encoding: requires valid UTF-8. A file that is not valid UTF-8 (e.g.
 * GBK-encoded, or containing a BOM-mangled/binary payload) is reported as
 * a single fatal error rather than silently mojibake-ing keyword text -
 * this matters because malformed keywords could otherwise silently create
 * useless/unmatchable rules.
 */
export function parseRulesCsv(buffer: Buffer): CsvParseOutcome {
  if (buffer.length === 0) {
    return { rows: [], fatalError: 'File is empty.' };
  }

  let text: string;
  try {
    text = decodeUtf8Strict(buffer);
  } catch {
    return {
      rows: [],
      fatalError: 'File is not valid UTF-8 text. Please re-save the CSV as UTF-8.',
    };
  }

  // Strip a UTF-8 BOM if present (common from Excel "CSV UTF-8" exports).
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  if (withoutBom.trim().length === 0) {
    return { rows: [], fatalError: 'File is empty.' };
  }

  let records: Record<string, string>[];
  try {
    records = parse(withoutBom, {
      columns: (header: string[]) => header.map((h) => h.trim()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown parse error';
    return { rows: [], fatalError: `Malformed CSV: ${detail}` };
  }

  if (records.length === 0) {
    return { rows: [], fatalError: 'File has a header row but no data rows.' };
  }

  const headerKeys = Object.keys(records[0]);
  const normalizedHeaderMap = new Map(headerKeys.map((k) => [k.toLowerCase(), k]));
  const missing = REQUIRED_COLUMNS.filter((col) => !normalizedHeaderMap.has(col.toLowerCase()));
  if (missing.length > 0) {
    return { rows: [], fatalError: `Missing required column(s): ${missing.join(', ')}` };
  }

  const getCol = (record: Record<string, string>, col: string): string | undefined => {
    const key = normalizedHeaderMap.get(col.toLowerCase());
    if (key === undefined) return undefined;
    const value = record[key];
    return value === undefined || value === '' ? undefined : value;
  };

  const rows: RawImportRow[] = records.map((record, idx) => ({
    // Line 1 is the header, so first data row is line 2 - matches what a
    // human opening the file in a text/spreadsheet editor would call it.
    line: idx + 2,
    keyword: getCol(record, 'keyword') ?? '',
    level: getCol(record, 'level') ?? '',
    matchField: getCol(record, 'matchField') ?? '',
    matchMode: getCol(record, 'matchMode'),
    category: getCol(record, 'category'),
    notes: getCol(record, 'notes'),
  }));

  return { rows };
}

/** Throws if `buffer` contains a byte sequence that is not valid UTF-8. */
function decodeUtf8Strict(buffer: Buffer): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(buffer);
}
