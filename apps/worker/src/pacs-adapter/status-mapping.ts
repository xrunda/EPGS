import { PacsReportStatus } from '@epgs/shared-types';

/**
 * Maps a raw PACS/RIS source status code/value to an internal
 * PacsReportStatus.
 *
 * The concrete source vocabulary (STUDYSTATUS / REPORTINFO status
 * columns) has NOT been verified against a production database - see
 * docs/pacs-ris-adapter.md "待生产环境核验". The strings recognized here
 * are best-effort placeholders based on common PACS/RIS terminology
 * (exam in progress / awaiting report / draft / submitted-pending-review
 * / reviewed / final-reviewed).
 *
 * Design rule (per issue #2 acceptance criteria): any code not present
 * in this map returns PacsReportStatus.UNKNOWN. It must NEVER default
 * to FINAL_REVIEWED or REVIEWED - unmapped codes must stay observable
 * as UNKNOWN so they can be triaged rather than silently trusted as
 * "already reviewed".
 */
const RAW_STATUS_MAP: Readonly<Record<string, PacsReportStatus>> = Object.freeze({
  // Exam/study lifecycle (no report content yet)
  IN_PROGRESS: PacsReportStatus.EXAM_IN_PROGRESS,
  EXAM_IN_PROGRESS: PacsReportStatus.EXAM_IN_PROGRESS,
  AWAITING_REPORT: PacsReportStatus.AWAITING_REPORT,
  NOT_STARTED: PacsReportStatus.AWAITING_REPORT,

  // Report drafted but not yet submitted for review
  DRAFT: PacsReportStatus.DRAFT,
  SAVED: PacsReportStatus.DRAFT,

  // Submitted, awaiting review/audit
  SUBMITTED: PacsReportStatus.PENDING_REVIEW,
  PENDING_REVIEW: PacsReportStatus.PENDING_REVIEW,
  PENDING_AUDIT: PacsReportStatus.PENDING_REVIEW,

  // Passed at least one level of review
  REVIEWED: PacsReportStatus.REVIEWED,
  PRELIMINARY_AUDITED: PacsReportStatus.REVIEWED,

  // Final sign-off / most authoritative state
  FINAL: PacsReportStatus.FINAL_REVIEWED,
  AUDITED: PacsReportStatus.FINAL_REVIEWED,
  FINAL_REVIEWED: PacsReportStatus.FINAL_REVIEWED,
  SIGNED_OFF: PacsReportStatus.FINAL_REVIEWED,
});

/**
 * Normalizes a raw status string (trims, uppercases) and looks it up in
 * RAW_STATUS_MAP. Returns PacsReportStatus.UNKNOWN for null/empty/
 * unrecognized input - callers should retain the original raw value
 * separately (see PacsReportDto.rawStatusCode) for observability.
 */
export function mapRawStatus(raw: string | null | undefined): PacsReportStatus {
  if (raw == null) {
    return PacsReportStatus.UNKNOWN;
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized.length === 0) {
    return PacsReportStatus.UNKNOWN;
  }
  return RAW_STATUS_MAP[normalized] ?? PacsReportStatus.UNKNOWN;
}
