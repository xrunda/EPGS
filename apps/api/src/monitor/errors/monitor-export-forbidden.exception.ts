import { ForbiddenException } from '@nestjs/common';

/**
 * Thrown when the caller holds a monitor read role but not the `patientDetail`
 * grant, so they may see the (masked) workbench but may not take a copy of it.
 *
 * Deliberately a DISTINCT code from RolesGuard's `FORBIDDEN`: the two 403s mean
 * different things - "you may not read the workbench at all" versus "you may
 * read it, but not export it" - and the modal says something different for
 * each. It also means the e2e helper that asserts `code === 'FORBIDDEN'` must
 * not be reused for this case.
 *
 * The reason the export needs a stronger grant than the list is the owner's
 * 2026-10-16 decision that the CSV always carries the raw patient phone: the
 * file is the one surface that leaves the system, and the phone is the HIGH
 * sensitivity field docs/data-dictionary.md keeps out of bulk responses.
 */
export class MonitorExportForbiddenException extends ForbiddenException {
  constructor() {
    super({
      code: 'PATIENT_DETAIL_REQUIRED',
      message: '没有导出患者明细的权限，请联系管理员开通。',
    });
  }
}
