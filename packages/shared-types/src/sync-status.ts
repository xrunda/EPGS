/**
 * Response shape for `GET /api/system/sync-status` (issue #6).
 *
 * Reflects the most recent apps/worker sync_job_log row(s) for the
 * incremental PACS/RIS sync job. Contains NO patient data - only
 * operational counts, cursor/window bookkeeping, and a sanitized error
 * summary (see SyncJobLog.errorSummary doc in schema.prisma /
 * docs/data-dictionary.md).
 */
export type SyncHealthState = 'HEALTHY' | 'DELAYED' | 'FAILED' | 'UNKNOWN';

export interface SyncStatusDto {
  /** Logical job name (e.g. "pacs-ris-incremental-sync"). */
  jobName: string;
  /**
   * Derived health classification:
   * - HEALTHY: most recent run SUCCEEDED (or PARTIAL) within the
   *   expected cadence (configurable multiple of the sync interval).
   * - DELAYED: the last successful run is older than expected, but not
   *   old enough to be classified FAILED (or the most recent run is
   *   still RUNNING past a reasonable duration).
   * - FAILED: the most recent run FAILED, or no successful run has ever
   *   completed within a much longer grace window.
   * - UNKNOWN: no sync_job_log rows exist at all yet (job has never run).
   */
  health: SyncHealthState;
  /** ISO 8601 UTC timestamp of the last run that finished as SUCCEEDED or PARTIAL, if any. */
  lastSuccessAt: string | null;
  /** ISO 8601 UTC timestamp of the most recent run of any status, if any. */
  lastRunAt: string | null;
  /** Status of the most recent run (RUNNING/SUCCEEDED/FAILED/PARTIAL), if any. */
  lastRunStatus: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL' | null;
  /** Resume cursor left by the last successful (SUCCEEDED or PARTIAL) run. */
  cursor: string | null;
  /** Read/success/failure counts from the most recent run. */
  readCount: number;
  successCount: number;
  failureCount: number;
  /** Sanitized error summary from the most recent run, if any (never contains patient data - see SyncJobLog doc). */
  errorSummary: string | null;
  /** Configured sync interval in minutes, for client-side "how stale is this" context. */
  syncIntervalMinutes: number;
}
