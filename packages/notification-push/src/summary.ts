import { PushSummary } from './types';

/**
 * Shanghai-day math + the summary provider seam for the shared push pipeline
 * (issue: push rules).
 *
 * A push message's numbers are "今日新报告" counts: monitor_record rows whose
 * examTime falls inside TODAY's Asia/Shanghai calendar day. Asia/Shanghai has
 * no DST, so a Shanghai day is always exactly 24h - the boundary math needs
 * no DST special-casing and relies on Intl / explicit +08:00 offsets (same
 * rationale as apps/api/src/monitor/monitor-time.ts, whose resolveDateRange
 * this mirrors for a single day).
 *
 * The provider seam lets each app reuse its OWN aggregation: apps/api adapts
 * MonitorService.summary (so a push message matches the workbench exactly),
 * apps/worker computes the same buckets with a GROUP BY over its Prisma
 * client. `date` absent means "count the full inventory" - this is exactly
 * the test-send behavior, so pushToChannel without a window stays
 * byte-for-byte compatible with the pre-refactor test-send.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Inclusive lower / exclusive upper bound of one Shanghai calendar day. */
export interface ShanghaiDayRange {
  gte: Date;
  lt: Date;
}

/**
 * Resolve a Shanghai YYYY-MM-DD into [start of that day, start of the next
 * day) UTC instants. Rejects non-YYYY-MM-DD or impossible calendar dates
 * (2026-02-31) - V8's ISO parser silently normalizes those, which would
 * quietly count the wrong day, so validity is checked explicitly via a
 * component round-trip (same approach as monitor-time.ts).
 */
export function resolveShanghaiDayRange(date: string): ShanghaiDayRange {
  if (!DATE_RE.test(date)) {
    throw new Error(`Invalid date "${date}". Expected a valid calendar date in YYYY-MM-DD format.`);
  }
  const [year, month, day] = date.split('-').map((part) => Number(part));
  assertValidCalendarDate(year, month, day, date);
  const gte = new Date(`${date}T00:00:00+08:00`);
  return { gte, lt: new Date(gte.getTime() + MS_PER_DAY) };
}

function assertValidCalendarDate(year: number, month: number, day: number, original: string): void {
  const reconstructed = new Date(Date.UTC(year, month - 1, day));
  const valid =
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() === month - 1 &&
    reconstructed.getUTCDate() === day;
  if (!valid) {
    throw new Error(`Invalid date "${original}". Expected a valid calendar date in YYYY-MM-DD format.`);
  }
}

const shanghaiDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Formats a UTC instant as the Asia/Shanghai 'YYYY-MM-DD' wall-clock date. */
export function formatShanghaiDate(instant: Date): string {
  const parts = shanghaiDateFormatter
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Aggregation seam for the numbers a push message carries. `scope` is the
 * caller's department scope (empty array = global), matching
 * MonitorService.summary's contract so the api adapter can pass it through.
 */
export interface NotificationSummaryProvider {
  get(input: { date?: string; scope?: string[] }): Promise<PushSummary>;
}
