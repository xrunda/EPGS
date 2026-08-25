import { KeywordHit, PushLevel, PushSummary } from './types';

/**
 * Template rendering for the shared push pipeline (issue: push rules). Moved
 * verbatim from apps/api (notification-test-send.service.ts) so the manual
 * "run now" and the worker's scheduled tick render byte-for-byte identically.
 */

/**
 * Replaces every {{key}} token in `template` using `variables`. Unknown
 * tokens are left verbatim (so a future/typo'd placeholder renders visibly
 * rather than vanishing silently). Pure + exported for unit testing.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (match, key: string) => {
    const value = variables[key.trim()];
    return value !== undefined ? value : match;
  });
}

/**
 * Formats the keyword hits of one level into the string backing a template
 * variable (issue #69): "词 ×次数" pairs joined by 、, TOP-N by count with a
 * trailing "其他 N 词共 M 次", and "—" when that level has no hits. Counts
 * are MATCH counts, never record counts, so the number after × cannot be
 * read as patient count. `topN` is the cap for the per-word list.
 */
export function formatKeywordHits(keywordHits: KeywordHit[], level: PushLevel, topN: number): string {
  const hits = keywordHits
    .filter((hit) => hit.level === level)
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword, 'zh-CN'));

  if (hits.length === 0) return '—';

  const top = hits.slice(0, topN);
  const rest = hits.slice(topN);
  const parts = top.map((hit) => `${hit.keyword} ×${hit.count}`);
  if (rest.length > 0) {
    const restCount = rest.reduce((sum, hit) => sum + hit.count, 0);
    parts.push(`其他 ${rest.length} 词共 ${restCount} 次`);
  }
  return parts.join('、');
}

/**
 * Builds the variable dictionary passed to renderTemplate from a summary.
 * Keys are the FIXED dictionary served by GET /api/notification-templates/
 * variables (reportDate / hospitalName / redCount / yellowCount / greenCount /
 * unclassifiedCount / totalCount / redKeywords / yellowKeywords) - never
 * user-defined variable names.
 */
export function buildNotificationVariables(
  summary: PushSummary,
  opts: { reportDate: string; hospitalName: string },
): Record<string, string> {
  return {
    reportDate: opts.reportDate,
    hospitalName: opts.hospitalName,
    redCount: String(summary.red),
    yellowCount: String(summary.yellow),
    greenCount: String(summary.green),
    unclassifiedCount: String(summary.unclassified),
    totalCount: String(summary.total),
    redKeywords: formatKeywordHits(summary.keywordHits, 'RED', 5),
    yellowKeywords: formatKeywordHits(summary.keywordHits, 'YELLOW', 3),
  };
}
