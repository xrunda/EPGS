import { PushSummary } from './types';

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
 * Builds the variable dictionary passed to renderTemplate from a summary.
 * Keys are the FIXED dictionary served by GET /api/notification-templates/
 * variables (reportDate / hospitalName / redCount / yellowCount / greenCount /
 * unclassifiedCount / totalCount) - never user-defined variable names.
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
  };
}
