import { FetchReportsParams, FetchReportsResult } from '@epgs/shared-types';

/**
 * Injection token for the active PacsRisAdapter implementation. Use this
 * token (not the class) to inject the adapter, so it can be swapped
 * between SqlPacsRisAdapter and FixturePacsRisAdapter via
 * PACS_ADAPTER_MODE without consumers caring which one is active.
 */
export const PACS_RIS_ADAPTER = Symbol('PACS_RIS_ADAPTER');

/**
 * Read-only data access contract for PACS/RIS endoscopy exam and report
 * data. Implementations MUST:
 *
 * - Never write, update, or delete anything in the source system.
 * - Bound every query by time range and page size (no unbounded scans).
 * - Return REPORTCONTENT text (`describeText` / `diagnoseText`) verbatim,
 *   with no cleansing/rewriting.
 * - Map unrecognized source statuses to `PacsReportStatus.UNKNOWN`
 *   rather than guessing.
 *
 * See docs/pacs-ris-adapter.md for the assumed source schema and the
 * list of items that need production-environment verification.
 */
export interface PacsRisAdapter {
  /**
   * Fetch one page of normalized reports whose `sourceUpdatedAt` falls
   * within [params.since, params.until ?? now), optionally filtered by
   * department/device, walking forward via `params.cursor`.
   */
  fetchReports(params: FetchReportsParams): Promise<FetchReportsResult>;
}
