import { CronTime } from 'cron';

/**
 * Cron evaluation for push rules (issue: push rules).
 *
 * Why cron@^4 instead of the repo's transitive cron@3.2.1 (pulled in by
 * @nestjs/schedule): v3 does not expose the timezone-aware matching API we
 * need here. cron@4 is a luxon-based rewrite whose CronTime validates an
 * expression on construction and can compute the next fire instant in a
 * named IANA timezone.
 *
 * Rules are minute-granularity (5-field) expressions evaluated against
 * Asia/Shanghai EXPLICITLY - never the process TZ - so a rule's "每天 9 点"
 * means 09:00 Shanghai regardless of what TZ the worker container runs in.
 */

export const PUSH_CRON_TIMEZONE = 'Asia/Shanghai';

/** True when `expression` is a parseable 5- or 6-field cron pattern. */
export function isValidCronExpression(expression: string): boolean {
  return CronTime.validateCronExpression(expression).valid;
}

/**
 * True when the cron fires during the same minute (in `timezone`) as `at`.
 *
 * Implemented as "is the next fire instant after (minuteStart - 1ms) within
 * the minute containing `at`?" - a 5-field cron has an implicit seconds=0
 * field, so without minute alignment a tick at 09:00:37 would never match
 * "0 9 * * *". Minute alignment makes "fires in this minute" the unit of
 * truth. See cron.spec.ts for the timezone / cross-day boundary cases.
 */
export function isCronDueAt(
  expression: string,
  at: Date,
  timezone: string = PUSH_CRON_TIMEZONE,
): boolean {
  const cronTime = new CronTime(expression, timezone);
  const minuteStart = new Date(at.getTime());
  minuteStart.setUTCSeconds(0, 0);
  const minuteEnd = new Date(minuteStart.getTime() + 60_000);
  // `getNextDateFrom` returns the next fire strictly after the start; asking
  // from 1ms before the minute lets a fire AT the minute boundary count.
  const next = cronTime.getNextDateFrom(new Date(minuteStart.getTime() - 1), timezone);
  return next.toMillis() < minuteEnd.getTime();
}
