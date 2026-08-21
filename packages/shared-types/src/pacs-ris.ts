/**
 * Stable internal DTOs for the PACS/RIS read-only adapter (issue #2),
 * converged to the confirmed IRIS/Caché gateway contract (issue #24, #26).
 *
 * These types decouple downstream consumers (the sync job in issue #6,
 * and potentially apps/api for read models in later issues) from the
 * PACS/RIS vendor schema. Per the read-only display spec (#27) and the
 * IRIS contract (#28) the DTO carries ONLY the confirmed source snapshot
 * fields: source stable ID, patient/study display fields, and the report
 * body. No workflow/review status, no sex/age/inpatient number, no
 * disposition fields - see docs/api/pacs-ris-data-api.md §9 for the
 * removed legacy contract fields.
 *
 * IMPORTANT: nothing in this file may contain real patient data. These
 * are type/shape definitions only.
 */

/**
 * One normalized PACS/RIS report record, joined across the source system's
 * study/patient/report data.
 *
 * Field-level notes:
 * - `reportContent` / `diagnosis` are returned verbatim from the source -
 *   the adapter performs no cleansing or rewriting.
 * - All timestamps are `Date` objects in UTC; the source database's
 *   session/column timezone is assumed to be Asia/Shanghai unless the
 *   production verification doc says otherwise (see
 *   docs/pacs-ris-adapter.md).
 * - `reportId` and `sourceUpdatedAt` are internal sync bookkeeping: the
 *   gateway contract (#28) no longer provides them, so adapters derive
 *   them (e.g. `reportId = sourceRecordId`, `sourceUpdatedAt = examTime`).
 */
export interface PacsReportDto {
  /**
   * Stable source record ID (来源稳定 ID) - the confirmed stable primary
   * key from the source system. Primary half of the idempotent sync key
   * (with reportId/reportVersion on MonitorRecord).
   */
  sourceRecordId: string;
  /** PATIENTINFO patient name, verbatim from source. HIGH sensitivity. */
  patientName: string;
  /** Ordering/performing department at time of sync. */
  department: string | null;
  /** Current bed number; empty for outpatient/unknown -> display as "—". */
  bedNo: string | null;
  /** Patient type code from the source (PAADM_Type raw value, e.g. I/O). */
  patientTypeCode: string | null;
  /**
   * Confirmed Chinese meaning of patientTypeCode (住院/门诊/…). NULL until
   * the hospital dictionary confirms the mapping - unknown values must not
   * be guessed.
   */
  patientTypeName: string | null;
  /** Exam/procedure item name (e.g. "电子胃镜检查"). */
  examItem: string;
  /** Exam start/performed time. */
  examTime: Date;
  /** REPORTINFO primary key for this specific report record/version. Internal sync bookkeeping. */
  reportId: string;
  /** Report findings/body text verbatim (检查所见), for read-only display. */
  reportContent: string | null;
  /** Diagnostic impression text verbatim (诊断意见), for read-only display. */
  diagnosis: string | null;
  /**
   * Best-known "last modified" timestamp for this record from the
   * source (used to drive incremental sync cursors). Internal sync
   * bookkeeping - not displayed.
   */
  sourceUpdatedAt: Date;
}

/**
 * Query parameters for PacsRisAdapter#fetchReports.
 *
 * `since` is required so every query has a time lower bound; `until`
 * defaults to "now" in the adapter implementation if omitted. Both
 * bound the query so no adapter implementation may run an unbounded
 * full-table scan.
 */
export interface FetchReportsParams {
  /** Inclusive lower bound on sourceUpdatedAt (or examTime, see adapter docs). */
  since: Date;
  /** Exclusive/inclusive upper bound - see adapter implementation notes. Defaults to "now". */
  until?: Date;
  /** Optional department filter (matches PacsReportDto.department). */
  department?: string;
  /** Optional device/modality filter, if the source distinguishes equipment. */
  deviceId?: string;
  /** Opaque pagination cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Max rows to return in this page. Adapters must enforce a hard ceiling. */
  pageSize: number;
}

/** One page of results from PacsRisAdapter#fetchReports. */
export interface FetchReportsResult {
  items: PacsReportDto[];
  /** Present when more results exist beyond this page. */
  nextCursor?: string;
}
