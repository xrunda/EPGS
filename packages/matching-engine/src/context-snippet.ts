/**
 * Builds a de-identification-conscious context excerpt around one match,
 * sliced from the ORIGINAL (non-normalized) text so the audit trail
 * reflects exactly what was in the report.
 *
 * Bounded to fit MonitorMatch.contextSnippet's varchar(500) budget (see
 * schema.prisma) - callers persisting this into that column can store it
 * directly without further truncation in the common case, though this
 * function itself enforces a smaller default so multiple occurrences'
 * snippets can co-exist in typical display contexts.
 */

const DEFAULT_CONTEXT_RADIUS = 20;

export function buildContextSnippet(
  originalText: string,
  start: number,
  end: number,
  radius: number = DEFAULT_CONTEXT_RADIUS,
): string {
  const excerptStart = Math.max(0, start - radius);
  const excerptEnd = Math.min(originalText.length, end + radius);
  const prefix = excerptStart > 0 ? '…' : '';
  const suffix = excerptEnd < originalText.length ? '…' : '';
  return `${prefix}${originalText.slice(excerptStart, excerptEnd)}${suffix}`;
}
