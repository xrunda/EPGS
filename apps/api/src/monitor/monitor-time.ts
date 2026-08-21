import { BadRequestException } from '@nestjs/common';

/**
 * Asia/Shanghai display formatting + exam-date range resolution for the
 * monitor workbench API (issue #7).
 *
 * All persisted timestamps stay UTC `Date`/`Timestamptz` (issue #6
 * convention); this module only handles DISPLAY (Shanghai wall-clock
 * strings) and QUERY-BOUNDARY (calendar day → UTC instant) conversion.
 * Asia/Shanghai has no DST, so a Shanghai day is always exactly 24h - the
 * boundary math below needs no DST special-casing, but relies on Intl /
 * explicit +08:00 offsets rather than manual offset arithmetic (same
 * rationale as apps/worker/src/sync/time-format.ts).
 */

export interface DateRange {
  /** Inclusive lower bound (start of the examDateFrom Shanghai day). */
  gte?: Date;
  /** Exclusive upper bound (start of the day AFTER examDateTo). */
  lt?: Date;
}

export interface ShanghaiDateTime {
  /** 'YYYY-MM-DD' in Asia/Shanghai. */
  date: string;
  /** 'HH:mm:ss' in Asia/Shanghai (00-23, never 24:00:00). */
  time: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve `examDateFrom`/`examDateTo` into an inclusive-start / exclusive-
 * end UTC range over Asia/Shanghai day boundaries:
 *   from = start of the from-date's Shanghai day  (gte, inclusive)
 *   to   = start of the NEXT Shanghai day          (lt,  exclusive)
 * so `examDateTo=2026-08-20` includes records at 2026-08-20 23:59 but
 * excludes those at 2026-08-21 00:00.
 *
 * Returns null when neither bound is provided (no time filter).
 * Throws BadRequestException INVALID_DATE_PARAM when a bound is not a
 * valid calendar date - the DTO regex already guarantees the YYYY-MM-DD
 * FORMAT, but the regex alone lets impossible dates like 2026-02-31
 * through, and V8's ISO parser SILENTLY normalizes those (2026-02-31 →
 * 2026-03-02) instead of producing an Invalid Date - which would quietly
 * return results for the wrong day range rather than an error. So calendar
 * validity is checked explicitly here (component round-trip).
 */
export function resolveDateRange(examDateFrom?: string, examDateTo?: string): DateRange | null {
  if (!examDateFrom && !examDateTo) return null;

  const range: DateRange = {};
  if (examDateFrom) {
    range.gte = parseShanghaiDay(examDateFrom);
  }
  if (examDateTo) {
    const startOfDayAfter = new Date(parseShanghaiDay(examDateTo).getTime() + MS_PER_DAY);
    range.lt = startOfDayAfter;
  }
  return range;
}

function parseShanghaiDay(date: string): Date {
  if (!DATE_RE.test(date)) {
    throw new BadRequestException({
      code: 'INVALID_DATE_PARAM',
      message: `Invalid date "${date}". Expected a valid calendar date in YYYY-MM-DD format.`,
    });
  }
  const [year, month, day] = date.split('-').map((part) => Number(part));
  assertValidCalendarDate(year, month, day, date);
  return new Date(`${date}T00:00:00+08:00`);
}

/**
 * Rejects impossible calendar dates (e.g. 2026-02-31, 2026-04-31) that the
 * regex cannot catch. V8's ISO parser silently normalizes such dates (see
 * parseShanghaiDay's doc), so instead of trusting the parser we reconstruct
 * the date from its components and compare round-trip: Date.UTC normalizes
 * the same way, and a mismatch means the input day never existed. Years are
 * 4-digit (regex-enforced), so Date.UTC's 0-99 special case never applies.
 */
function assertValidCalendarDate(year: number, month: number, day: number, original: string): void {
  const reconstructed = new Date(Date.UTC(year, month - 1, day));
  const valid =
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() === month - 1 &&
    reconstructed.getUTCDate() === day;
  if (!valid) {
    throw new BadRequestException({
      code: 'INVALID_DATE_PARAM',
      message: `Invalid date "${original}". Expected a valid calendar date in YYYY-MM-DD format.`,
    });
  }
}

// hourCycle h23 keeps midnight as 00:00:00 - with plain hour12:false the
// zh-CN locale can render midnight as 24:00:00.
const shanghaiFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Formats a UTC instant as Asia/Shanghai 'YYYY-MM-DD' + 'HH:mm:ss' (display only). */
export function formatShanghaiDateTime(instant: Date): ShanghaiDateTime {
  const parts = shanghaiFormatter
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
