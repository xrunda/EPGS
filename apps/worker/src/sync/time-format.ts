/**
 * Formats a UTC `Date` instant as an Asia/Shanghai business-timezone
 * display string, for LOG LINES ONLY (never for persistence - all
 * persisted timestamps stay UTC `Date`/`Timestamptz`, per issue #6's
 * "内部持久化建议用 UTC" guidance and the already-merged Prisma schema's
 * `@db.Timestamptz(6)` columns).
 *
 * Uses `Intl.DateTimeFormat` with an explicit IANA zone rather than
 * manual offset arithmetic, so this is correct regardless of host
 * timezone/locale and needs no DST handling (Asia/Shanghai has none,
 * but Intl handles that transparently either way - this code does not
 * special-case it).
 */
export function formatShanghai(date: Date): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (Asia/Shanghai)`;
}
