/**
 * Stable internal DTOs for the PACS/RIS read-only adapter (issue #2).
 *
 * These types decouple downstream consumers (the sync job in issue #6,
 * and potentially apps/api for read models in later issues) from the
 * PACS/RIS vendor schema (PATIENTINFO / STUDYINFO / REPORTINFO /
 * REPORTCONTENT / LOC / STUDYSTATUS). See docs/pacs-ris-adapter.md for
 * the assumed source schema, join keys, and what still needs production
 * verification.
 *
 * IMPORTANT: nothing in this file may contain real patient data. These
 * are type/shape definitions only.
 */

/**
 * Internal, normalized report workflow status.
 *
 * Source systems typically encode this in STUDYSTATUS / REPORTINFO with
 * vendor-specific codes (e.g. numeric or short string codes that differ
 * per PACS/RIS vendor and even per hospital deployment). Any source code
 * that cannot be confidently mapped to one of the known values below
 * MUST map to `UNKNOWN` - it must never silently default to
 * `FINAL_REVIEWED` or any other "looks done" status. See
 * docs/pacs-ris-adapter.md for the assumed source status vocabulary.
 */
export enum PacsReportStatus {
  /** Study/exam has started but no report content exists yet. */
  EXAM_IN_PROGRESS = 'EXAM_IN_PROGRESS',
  /** Exam finished, report not yet started/saved. */
  AWAITING_REPORT = 'AWAITING_REPORT',
  /** A draft report has been saved but not submitted for review. */
  DRAFT = 'DRAFT',
  /** Report submitted, awaiting first-level review/audit. */
  PENDING_REVIEW = 'PENDING_REVIEW',
  /** Report has passed one level of review (may not be final). */
  REVIEWED = 'REVIEWED',
  /** Report has passed final review/sign-off (most authoritative state). */
  FINAL_REVIEWED = 'FINAL_REVIEWED',
  /**
   * Source provided a status code/value the adapter does not recognize.
   * Consumers must treat this as "needs human/observability attention",
   * never as equivalent to FINAL_REVIEWED or REVIEWED.
   */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Administrative sex as recorded in PATIENTINFO. Kept intentionally
 * narrow (no clinical inference) and includes UNKNOWN for unmapped or
 * missing source values.
 */
export type PacsPatientSex = 'M' | 'F' | 'UNKNOWN';

/**
 * One normalized PACS/RIS report record, joined across
 * STUDYINFO / PATIENTINFO / REPORTINFO / REPORTCONTENT.
 *
 * Field-level notes:
 * - `describeText` / `diagnoseText` are returned verbatim from
 *   REPORTCONTENT.RPT_DESCRIBE / RPT_DIAGNOSE - the adapter performs no
 *   cleansing, trimming-for-meaning, or rewriting. Leading/trailing
 *   whitespace-only normalization (if any) is documented on the field.
 * - `inpatientNo` is optional: outpatient/emergency endoscopy studies
 *   commonly have no inpatient number in PACS/RIS.
 * - All timestamps are `Date` objects in UTC; the source database's
 *   session/column timezone is assumed to be Asia/Shanghai unless the
 *   production verification doc says otherwise (see
 *   docs/pacs-ris-adapter.md).
 */
export interface PacsReportDto {
  /** PATIENTINFO.PAT_ID (assumed stable internal patient identifier). */
  patientId: string;
  /** PATIENTINFO inpatient/admission number, if the study is inpatient. */
  inpatientNo: string | null;
  /** PATIENTINFO patient name, verbatim from source. */
  patientName: string;
  sex: PacsPatientSex;
  /** Age at time of study, as recorded by source (not recomputed). */
  age: number | null;
  /** Ordering/performing department (assumed from LOC or STUDYINFO). */
  department: string | null;
  /** Bed number, inpatient studies only. */
  bedNo: string | null;
  /** STUDYINFO.ST_ACCNUM - the accession number joining Study/Report/Content. */
  studyAccessionNo: string;
  /** Exam/procedure item name (e.g. "胃镜", "肠镜"). */
  examItem: string;
  /** Exam start/performed time. */
  examTime: Date;
  /** REPORTINFO primary key for this specific report record/version. */
  reportId: string;
  /** Normalized workflow status - see PacsReportStatus. */
  reportStatus: PacsReportStatus;
  /** Raw source status code/value, kept for audit/debugging when status maps to UNKNOWN. */
  rawStatusCode: string | null;
  /** When the report content was first saved (draft), if known. */
  reportSavedAt: Date | null;
  /** When the report was submitted for review, if known. */
  reportSubmittedAt: Date | null;
  /** When the report was reviewed/signed off, if known. */
  reportReviewedAt: Date | null;
  /** REPORTCONTENT.RPT_DESCRIBE verbatim - exam findings ("检查所见"). */
  describeText: string | null;
  /** REPORTCONTENT.RPT_DIAGNOSE verbatim - diagnostic impression ("诊断意见"). */
  diagnoseText: string | null;
  /**
   * Best-known "last modified" timestamp for this record from the
   * source (used to drive incremental sync cursors). Adapter
   * implementations should pick the max of available source update
   * columns - see docs/pacs-ris-adapter.md for the assumed columns.
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
