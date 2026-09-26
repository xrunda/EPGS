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

/**
 * The H5 detail payload is a BASE MonitorExamDetailDto, and it is BUILT from the
 * whitelist below rather than spread-and-hope.
 *
 * Issue #88 (PR-B) added AI fields to the workbench detail DTO. The alert H5
 * page must not carry them (the owner's rule is that the notification surface's
 * shape does not change, and a link can travel further than a workbench
 * session), so `getDetail` returns the wider type and this function narrows it.
 * `const { attentionSource, aiSemantics, ...rest } = dto` would be shorter but
 * expresses "we remembered to delete it"; a whitelist expresses "it cannot be
 * there", which is the property that survives the next person adding a field.
 *
 * The parameter is deliberately typed as the BASE DTO so this surface cannot
 * come to depend on the AI fields at all.
 */
export function maskAlertExamDetail(dto: MonitorExamDetailDto): MonitorExamDetailDto {
  return {
    recordId: dto.recordId,
    monitorLevel: dto.monitorLevel,
    patientName: maskName(dto.patientName),
    department: dto.department,
    bedNo: dto.bedNo,
    patientType: dto.patientType,
    examItem: dto.examItem,
    examDate: dto.examDate,
    examTime: dto.examTime,
    matchedKeywords: dto.matchedKeywords,
    reportContent: dto.reportContent,
    diagnosis: dto.diagnosis,
    hits: dto.hits,
    // Never set on this surface (the report body is never redacted here), so it
    // is only ever carried through, never introduced.
    ...(dto.dataAccess ? { dataAccess: dto.dataAccess } : {}),
  };
}
