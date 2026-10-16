import { MonitorLevel } from '@prisma/client';
import { formatShanghaiDateTime } from './monitor-time';

/**
 * CSV serialisation for the workbench data export (issue #139).
 *
 * Deliberately PURE - no DI, no Prisma client, no NestJS imports - the same way
 * monitor-time.ts and access/data-scope.ts are. The byte-level rules below
 * (BOM, CRLF, quoting, the formula guard) are the kind that silently corrupt a
 * file rather than throwing, so they have to be testable without a database in
 * the DB-free CI job.
 *
 * This module is the ONLY place that decides what leaves the system as a file.
 * Everything it emits is a row the caller was already authorized to read, with
 * two deliberate departures from the on-screen table, both recorded in
 * docs/api/monitor-api.md:
 *
 *  - the patient phone appears IN THE CLEAR (owner decision, 2026-10-16). The
 *    endpoint is gated on the `patientDetail` grant precisely because of this;
 *    there is no masked variant of this file.
 *  - `NULL` becomes an EMPTY CELL, not the screen's "—". The dash is a
 *    rendering decision; an exported blank sorts and filters as blank in Excel,
 *    and with #137's no-backfill decision "blank" is exactly what "the source
 *    had no value" means.
 */

/** The row shape this module consumes - a subset of the export select. */
export interface CsvExamRow {
  examTime: Date | null;
  currentLevel: MonitorLevel;
  patientName: string | null;
  patientSex: string | null;
  patientPhone: string | null;
  department: string | null;
  bedNo: string | null;
  patientTypeCode: string | null;
  patientTypeName: string | null;
  examItem: string | null;
  orderingDoctor: string | null;
  matches: { keyword: string }[];
}

/**
 * The doctor-facing names for the attention levels.
 *
 * Twin of `ATTENTION_LEVEL_LABELS` in apps/web/src/attentionSource.ts and of
 * the same map in the notification templates. The three MUST stay
 * word-identical: a CSV that says "红色" next to a screen that says "红色关注"
 * makes the reader wonder whether they are the same thing. There is no shared
 * runtime value across the api/web boundary in this repo, so this is a
 * documented duplication rather than an oversight.
 */
export const CSV_LEVEL_LABELS: Record<MonitorLevel, string> = {
  RED: '红色关注',
  YELLOW: '黄色关注',
  GREEN: '绿色关注',
  UNCLASSIFIED: '未分级',
};

/**
 * Column order mirrors the workbench table (so the file can be read next to the
 * screen), minus the two columns that do not belong in a file: 发现来源 is a
 * provenance badge rather than data, and 操作 is the drawer button. 手机号 has
 * no screen column at all (the list deliberately omits it) and is appended.
 *
 * There is deliberately NO id column: an exported file must not be joinable
 * back to internal record keys, and no reader needs one.
 */
const CSV_HEADERS = [
  '关注等级',
  '患者姓名',
  '性别',
  '科室',
  '床号',
  '患者类型',
  '开单医生',
  '检查项目',
  '检查日期',
  '检查时间',
  '命中关键词',
  '手机号',
] as const;

/**
 * Excel and LibreOffice EXECUTE a cell whose text starts with one of these, so
 * `=HYPERLINK(...)` in any patient-sourced field would run on open. Quoting
 * does NOT prevent it - only prefixing does. The data here comes from the
 * hospital's own PACS rather than from a user, so this is cheap insurance
 * rather than a live threat; the `'` is Excel's text marker and is consumed on
 * display, so a value like `+8613800000000` still reads correctly.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180: these four force the cell to be quoted. */
const NEEDS_QUOTING = /[",\r\n]/;

/** One cell: guard, then quote. Empty stays empty (never `""`). */
function cell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * `name（code）` when both are known, else whichever exists, else blank.
 *
 * The API must not INVENT a name for a code it does not recognise -
 * docs/data-dictionary.md is explicit that patient_type_name is the source's
 * value or nothing. (The web keeps a code→label fallback table for display;
 * that is a screen nicety and deliberately not ported here, because a file
 * someone files away should not carry this system's guess.)
 */
function patientTypeCell(row: CsvExamRow): string {
  const name = row.patientTypeName || '';
  const code = row.patientTypeCode || '';
  if (name && code) return `${name}（${code}）`;
  return name || code;
}

function toCells(row: CsvExamRow): string {
  // examTime is non-null for every exported row (the day range is a `gte`/`lt`
  // on that column, and NULL never satisfies a range comparison), but this
  // module must not throw on a row that somehow carries none.
  const when = row.examTime ? formatShanghaiDateTime(row.examTime) : null;
  return [
    cell(CSV_LEVEL_LABELS[row.currentLevel]),
    cell(row.patientName),
    cell(row.patientSex),
    cell(row.department),
    cell(row.bedNo),
    cell(patientTypeCell(row)),
    cell(row.orderingDoctor),
    cell(row.examItem),
    cell(when?.date),
    cell(when?.time),
    // `、` rather than `,` so a multi-keyword cell has no interaction with the
    // delimiter at all (and matches how the H5 list joins them).
    cell(row.matches.map((match) => match.keyword).join('、')),
    cell(row.patientPhone),
  ].join(',');
}

/**
 * The whole file as UTF-8 bytes: BOM + header + rows, CRLF-terminated.
 *
 * The BOM is what makes Excel on Windows read the Chinese headers as UTF-8
 * instead of mojibake - the same reason apps/worker/src/pacs-adapter's
 * mock-csv-convert.ts writes one. Note RulesModal's client-side CSV template
 * omits it; that inconsistency is pre-existing and is not copied here.
 *
 * An empty row set still produces a valid file: BOM + header line. The caller
 * decides whether to hand that to the user (it does not - see the modal).
 */
export function buildExamsCsv(rows: CsvExamRow[]): Buffer {
  const lines = [CSV_HEADERS.join(','), ...rows.map(toCells)];
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

/**
 * The attention levels in the order this system always shows them: 红 → 黄 →
 * 绿 → 未分级 (the same order as the config list, the export modal's cards and
 * the CSV's own level labels).
 *
 * Issue #145 made the export accept several levels at once, which turns "which
 * order" into a contract question rather than a layout detail: the filename has
 * to be a function of the SELECTION, not of the order the client happened to
 * list it in, or the same choice would download as two different names.
 */
export const EXPORT_LEVEL_ORDER: readonly MonitorLevel[] = [
  'RED',
  'YELLOW',
  'GREEN',
  'UNCLASSIFIED',
];

/**
 * De-duplicate and put a selection of levels into `EXPORT_LEVEL_ORDER`,
 * preserving anything unrecognised at the end.
 *
 * Unknown values are deliberately KEPT rather than dropped here: they are the
 * DTO's `@IsEnum` failure to report. Dropping them here would turn
 * `?levels=RED,PURPLE` into a 200 that quietly exports only red - the caller
 * would get a file and never learn that half the request was ignored.
 */
export function orderExportLevels(levels: readonly string[]): string[] {
  const unique = [...new Set(levels)];
  return [
    ...EXPORT_LEVEL_ORDER.filter((level) => unique.includes(level)),
    ...unique.filter((level) => !EXPORT_LEVEL_ORDER.includes(level as MonitorLevel)),
  ];
}

/**
 * The download filename, e.g. `数据导出-2026-08-20-红色关注+黄色关注.csv`.
 *
 * One name per SELECTION (see `orderExportLevels`), so re-running the same
 * choice overwrites the same file instead of piling up `…(1).csv`.
 *
 * Twin of `exportFileName` in apps/web/src/monitorApi.ts: the browser builds
 * the saved name itself (Content-Disposition is ignored on a fetch+blob
 * download), so the two must produce the same string. The server still sends
 * the header for the clients that DO use it - `curl -OJ`, a direct browser GET.
 */
export function csvFileName(examDate: string, levels: readonly MonitorLevel[]): string {
  const labels = orderExportLevels(levels).map(
    (level) => CSV_LEVEL_LABELS[level as MonitorLevel] ?? level,
  );
  return `数据导出-${examDate}-${labels.join('+')}.csv`;
}

/**
 * RFC 5987 `attr-char` excludes these, and `encodeURIComponent` leaves them
 * alone; a raw `'` or `*` in a header value is at best non-conforming.
 */
function encodeAttrValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition` for the response.
 *
 * Both forms are sent: the plain ASCII `filename=` first for clients that
 * ignore RFC 5987, then `filename*=`. Nothing here depends on an intermediary
 * preserving UTF-8 bytes, which is why the ASCII fallback is not optional.
 *
 * The ASCII form joins the enum names with `-` (`monitor-2026-08-20-RED-YELLOW.csv`)
 * because `+` is a legal `attr-char` but reads as a space in some download
 * managers; the Chinese form keeps `+`, which is how a human writes "红+黄".
 *
 * `examDate` has already passed the DTO's `^\d{4}-\d{2}-\d{2}$` check and every
 * entry of `levels` is an enum member, so neither can carry a CR/LF or a `"`
 * into the header. The encoder is belt-and-braces on top of that rather than
 * the defence itself.
 */
export function contentDispositionFor(examDate: string, levels: readonly MonitorLevel[]): string {
  const ordered = orderExportLevels(levels) as MonitorLevel[];
  const ascii = `monitor-${examDate}-${ordered.join('-')}.csv`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeAttrValue(csvFileName(examDate, ordered))}`;
}
