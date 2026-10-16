import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import { MonitorService } from './monitor.service';
import { ListExamsQueryDto } from './dto/list-exams.query.dto';
import { SummaryQueryDto } from './dto/summary.query.dto';
import { ExportExamsQueryDto } from './dto/export-exams.query.dto';
import { MonitorExportForbiddenException } from './errors/monitor-export-forbidden.exception';
import { contentDispositionFor } from './monitor-csv';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';
import { MonitorExamDetailDto, MonitorSummaryDto, PaginatedMonitorExams } from '@epgs/shared-types';

/**
 * Read-only monitor workbench endpoints (issue #7). No write operations
 * exist on this controller by design - the product converged to read-only
 * display (issue #26): these endpoints surface the synced exam snapshot,
 * the attention level, and the hit evidence, and nothing else.
 *
 * Issue #13 authorization: VIEWER / RULE_ADMIN / SYSTEM_ADMIN may read (AUDITOR
 * is deliberately excluded - the audit trail is its only surface). The scope
 * and masking options are derived from the caller's app_user_access grant
 * (@CurrentUser()): a scoped caller only ever sees their departments, and a
 * caller without patientDetail rights gets HIGH-sensitivity fields masked.
 * Each read is recorded as an EXAM_LIST / EXAM_DETAIL audit row (meta never
 * carries the raw `patientName` filter value).
 *
 * Issue #139 adds the one endpoint here that hands data back as a FILE rather
 * than as JSON: GET /api/monitor/export. It stays read-only - nothing is
 * written except its own audit row - but because a file leaves the system
 * intact, it is gated one step tighter than the list (the `patientDetail`
 * grant) and every call is recorded as EXAM_EXPORT. It is not a reintroduction
 * of the "导出日报" that issue #26 cancelled: no aggregation, no schedule, no
 * push, no closed-loop state.
 */
@ApiTags('monitor')
@Controller('api/monitor')
@RequireRoles(AppRole.VIEWER, AppRole.RULE_ADMIN, AppRole.SYSTEM_ADMIN)
export class MonitorController {
  constructor(
    private readonly monitorService: MonitorService,
    private readonly audit: AuditService,
  ) {}

  /** Data-scope + masking derived from the access grant; empty when unauthenticated (defense in depth). */
  private scopeOptions(user: AccessUser | null): { scope?: string[]; maskPatient?: boolean } {
    if (!user) return {};
    return { scope: user.departmentScope, maskPatient: !user.patientDetail };
  }

  @Get('exams')
  @ApiOperation({
    summary:
      'List monitored exams with combined filters, sorting and pagination. ' +
      'Read-only display snapshot - never returns reportContent/diagnosis (see GET /api/monitor/exams/:id).',
  })
  async list(
    @Query() query: ListExamsQueryDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<PaginatedMonitorExams> {
    const opts = this.scopeOptions(user);
    const result = await this.monitorService.list(query, opts);
    await this.audit.record({
      action: AuditAction.EXAM_LIST,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'monitor_record',
      department: query.department ?? undefined,
      meta: {
        scope: user?.departmentScope ?? [],
        department: query.department ?? null,
        level: query.level ?? null,
        patientTypeCode: query.patientTypeCode ?? null,
        examItem: query.examItem ?? null,
        examDateFrom: query.examDateFrom ?? null,
        examDateTo: query.examDateTo ?? null,
        // Only a flag - the raw patientName filter must not be stored in
        // the audit trail. keyword is a non-sensitive rule-library value
        // (selected from a dropdown) and is recorded verbatim.
        hadPatientName: (query.patientName ?? '') !== '',
        keyword: query.keyword ?? null,
        masked: opts.maskPatient ?? false,
        total: result.total,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Get('exams/:id')
  @ApiOperation({
    summary:
      'Get one exam full snapshot (including reportContent/diagnosis) and all hit evidence - the workbench detail drawer.',
  })
  async getDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<MonitorExamDetailDto> {
    const opts = this.scopeOptions(user);
    const result = await this.monitorService.getDetail(id, opts);
    await this.audit.record({
      action: AuditAction.EXAM_DETAIL,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'monitor_record',
      resourceId: id,
      department: result.department ?? undefined,
      meta: {
        masked: opts.maskPatient ?? false,
        level: result.monitorLevel,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Attention-level counts (total/red/yellow/green/unclassified) computed under the same filters as the list.',
  })
  summary(
    @Query() query: SummaryQueryDto,
    @CurrentUser() user: AccessUser | null,
  ): Promise<MonitorSummaryDto> {
    // Aggregate-only counts carry no patient identity, so summary is scoped
    // but not masked and not separately audited (the list page it accompanies
    // already wrote an EXAM_LIST row).
    return this.monitorService.summary(query, this.scopeOptions(user));
  }

  /**
   * Issue #139: one Shanghai day at the selected attention levels (one or more,
   * since #145), as a CSV file.
   *
   * The second gate below is the whole point of this endpoint's design. The
   * class-level @RequireRoles already covers "may read the workbench"; the
   * export additionally requires the `patientDetail` grant, because the file
   * carries the patient phone IN THE CLEAR (owner decision, 2026-10-16) and
   * `patientDetail` is exactly the grant that already lets its holder read that
   * same phone in the detail drawer. So this is not a new privilege - it is the
   * export refusing to be a way around the one that exists.
   *
   * A caller without it gets 403 PATIENT_DETAIL_REQUIRED, a code distinct from
   * RolesGuard's FORBIDDEN so the modal can say which of the two they hit.
   *
   * Delivery notes:
   *  - StreamableFile, NOT a non-passthrough @Res. If this handler took over
   *    the response and then threw (the row-cap probe, a Prisma error), the
   *    global exception filter would write its JSON error body into a response
   *    already labelled text/csv, and the browser would save it as a .csv.
   *    Returning a value keeps Nest in charge, so every failure stays a clean
   *    JSON envelope.
   *  - @Res({ passthrough: true }) is used ONLY to add the dynamic headers, and
   *    only after every step that can throw - including the audit write.
   *  - Cache-Control: no-store is not optional. A patient list must not be
   *    retained by any intermediary between here and the operator's machine.
   */
  @Get('export')
  @ApiOperation({
    summary:
      'Export one Shanghai day at the selected attention levels as a CSV file (issue #139, multi-level since #145). ' +
      'Requires the patientDetail grant: the file carries the raw patient phone. ' +
      'Never contains reportContent/diagnosis.',
  })
  async exportDay(
    @Query() query: ExportExamsQueryDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    // `user?.` rather than `user.`: @CurrentUser() yields null for an account
    // with no access row, so both "no grant" and "no access row" fail closed.
    if (!user?.patientDetail) throw new MonitorExportForbiddenException();

    // Scope only, deliberately not `this.scopeOptions(user)`: that helper also
    // carries the maskPatient flag, and an export has no masked mode. Passing
    // the flag here would suggest one exists and invite someone to "fix" the
    // omitted branch - the grant checked above already decided this call is a
    // detail-level read.
    const { rowCount, body } = await this.monitorService.exportDay(
      { examDate: query.examDate, levels: query.levels },
      { scope: user.departmentScope },
    );

    await this.audit.record({
      action: AuditAction.EXAM_EXPORT,
      actorUsername: user.username,
      actorRole: pickPrimaryRole(user.roles),
      resourceType: 'monitor_record',
      // The filter values and the count - never a patient field, and never the
      // file. Same discipline as EXAM_LIST's hadPatientName flag: the audit
      // trail must be readable without holding patient data, and this row is
      // the ONLY record that a copy left the system.
      meta: {
        scope: user.departmentScope,
        examDate: query.examDate,
        // The selection, as an array (#145) - one export of "red+yellow" is one
        // row here, which is what tells an auditor afterwards how wide the file
        // that left the system was.
        levels: query.levels,
        rowCount,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });

    // Custom headers only; type/disposition/length ride on the StreamableFile.
    // X-Row-Count is what lets the modal tell "nothing matched" from "here is
    // your file" without parsing the CSV. The name is deliberately generic: it
    // carries no verb, so it cannot be mistaken for an action-header and cannot
    // collide with the identifiers log-sanitization.spec.ts bans (a hyphen is a
    // word boundary there, so the obvious longer name would have tripped it).
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Row-Count', String(rowCount));
    return new StreamableFile(body, {
      type: 'text/csv; charset=utf-8',
      disposition: contentDispositionFor(query.examDate, query.levels),
      length: body.length,
    });
  }
}
