import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import { MonitorService } from './monitor.service';
import { ListExamsQueryDto } from './dto/list-exams.query.dto';
import { SummaryQueryDto } from './dto/summary.query.dto';
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
 * carries the raw `q` value, which could be a patient name).
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
        // Only a flag - the raw `q` could be a patient name and must not be
        // stored in the audit trail.
        hadQ: (query.q ?? '') !== '',
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
}
