import { MonitorExamDetailDto, MonitorExamDto } from '@epgs/shared-types';
import { maskName } from '../access/data-scope';

/**
 * Always-on masking for the alert H5 surface (issue #72, user decision):
 * the patient NAME is reduced to 姓氏 + * (same rule as issue #13's
 * maskName), while bed number / department / exam fields stay readable so a
 * doctor can locate the patient, and the detail keeps the report body and
 * hit snippets (that is the whole point of the link). This is therefore
 * NOT issue #13's maskExamRow/maskExamDetail (those also blank bedNo and
 * null the report), and `dataAccess.masked` is deliberately not set - that
 * flag means "report body redacted", which never happens here.
 */
export function maskAlertExamRow(dto: MonitorExamDto): MonitorExamDto {
  return { ...dto, patientName: maskName(dto.patientName) };
}

export function maskAlertExamDetail(dto: MonitorExamDetailDto): MonitorExamDetailDto {
  return { ...dto, patientName: maskName(dto.patientName) };
}
