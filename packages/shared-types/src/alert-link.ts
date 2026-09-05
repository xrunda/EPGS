/**
 * Wire DTOs for the WeCom alert-link H5 page (issue #72):
 * `GET /api/alert-links/me`, `GET /api/alert-links/me/exams`,
 * `GET /api/alert-links/me/exams/:id`.
 *
 * The caller authenticates with the opaque link token as a Bearer header
 * (docs/auth.md "预警链接受限凭证"); every response is narrowed to the link's
 * frozen record-id snapshot. Patient names are ALWAYS masked on this surface
 * (姓氏 + *), bed number and department are kept so a doctor can locate the
 * patient, and the detail keeps the report body + hit highlights. No
 * `dataAccess.masked` flag is set: that flag means "report body redacted",
 * which never happens here.
 */

import { MonitorExamDetailDto, MonitorExamDto, MonitorLevelDto } from './monitor';

/** Levels that get a link; UNCLASSIFIED never does. */
export type AlertLinkLevelDto = Exclude<MonitorLevelDto, 'UNCLASSIFIED'>;

/** `GET /api/alert-links/me` - what the link opens onto. Counts as one "open". */
export interface AlertLinkSummaryDto {
  level: AlertLinkLevelDto;
  /** Shanghai YYYY-MM-DD of the summary window the snapshot covers. */
  windowDate: string;
  /** Number of records frozen into the snapshot. */
  total: number;
  /** ISO 8601 UTC instants. */
  createdAt: string;
  expiresAt: string;
  hospitalName: string;
}

/** `GET /api/alert-links/me/exams` - the snapshot's rows, masked. */
export interface AlertLinkExamListDto {
  items: MonitorExamDto[];
  total: number;
}

/** `GET /api/alert-links/me/exams/:id` - same shape as the workbench detail, name masked. */
export type AlertLinkExamDetailDto = MonitorExamDetailDto;
