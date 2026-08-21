import { PacsReportStatus } from '@epgs/shared-types';
import { ReportStatus as PrismaReportStatus } from '@prisma/client';

/**
 * Maps the PACS/RIS adapter's normalized workflow status
 * (`PacsReportStatus`, packages/shared-types/src/pacs-ris.ts - issue #2)
 * to MonitorRecord's upstream status snapshot enum (`ReportStatus`,
 * apps/api/prisma/schema.prisma - issue #3).
 *
 * These two enums were defined independently by different issues and do
 * NOT share the same vocabulary or granularity:
 *   PacsReportStatus: EXAM_IN_PROGRESS, AWAITING_REPORT, DRAFT,
 *                      PENDING_REVIEW, REVIEWED, FINAL_REVIEWED, UNKNOWN
 *   Prisma ReportStatus: PRELIMINARY, FINAL, AMENDED, UNKNOWN
 *
 * This mapping is a DESIGN DECISION made by this issue (#6), not a
 * pre-existing contract, and is intentionally conservative:
 *
 * - FINAL_REVIEWED -> FINAL (the only PacsReportStatus meaning "final
 *   sign-off", matching Prisma's FINAL exactly).
 * - REVIEWED, PENDING_REVIEW, DRAFT -> PRELIMINARY (a report exists and
 *   has some content, but has not passed final review - "preliminary"
 *   is the closest available Prisma value; the finer-grained workflow
 *   distinction is preserved losslessly elsewhere by keeping the raw
 *   PacsReportStatus/rawStatusCode only in the sync job's in-memory
 *   processing, per issue #2's adapter contract).
 * - EXAM_IN_PROGRESS, AWAITING_REPORT -> UNKNOWN (no report content
 *   exists yet at all - "preliminary" would overstate what's known, and
 *   there is no Prisma status meaning "no report yet"; UNKNOWN is the
 *   safe choice, matching the schema's documented "never guess" rule).
 * - UNKNOWN -> UNKNOWN (unchanged).
 * - Prisma's AMENDED has NO corresponding PacsReportStatus value today -
 *   the #20 gateway contract has no "amended/revised" status of its own
 *   (a revision surfaces as a new `reportId`/`studyAccessionNo`+
 *   `reportVersion` combination instead - see MonitorRecord's
 *   reportVersion doc). This mapping never produces AMENDED; if the
 *   source system later exposes an explicit amendment flag, this
 *   function should be revisited rather than guessed at now.
 *
 * Any status value not explicitly listed here (defensive default, should
 * be unreachable given PacsReportStatus is a closed enum) also maps to
 * UNKNOWN rather than throwing, so a single unexpected value cannot fail
 * an otherwise-healthy sync batch.
 */
export function mapToRecordReportStatus(status: PacsReportStatus): PrismaReportStatus {
  switch (status) {
    case PacsReportStatus.FINAL_REVIEWED:
      return PrismaReportStatus.FINAL;
    case PacsReportStatus.REVIEWED:
    case PacsReportStatus.PENDING_REVIEW:
    case PacsReportStatus.DRAFT:
      return PrismaReportStatus.PRELIMINARY;
    case PacsReportStatus.EXAM_IN_PROGRESS:
    case PacsReportStatus.AWAITING_REPORT:
    case PacsReportStatus.UNKNOWN:
    default:
      return PrismaReportStatus.UNKNOWN;
  }
}

/**
 * Whether a report has completed human review upstream, per the
 * matching-engine's MatchInput.isReviewed contract (packages/
 * matching-engine/src/types.ts): "e.g. PacsReportStatus FINAL_REVIEWED /
 * REVIEWED". Kept as a single source of truth here so the sync runner
 * and any future consumer agree on the same definition.
 */
export function isReviewed(status: PacsReportStatus): boolean {
  return status === PacsReportStatus.FINAL_REVIEWED || status === PacsReportStatus.REVIEWED;
}
