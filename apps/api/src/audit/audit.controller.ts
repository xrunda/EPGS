import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import { PaginatedAuditLog } from '@epgs/shared-types';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';
import { AuditService } from './audit.service';
import { ListAuditQueryDto } from './dto/list-audit.query.dto';

/**
 * Read-only audit trail (issue #13). Restricted to the AUDITOR role at the
 * class level; every read also writes an AUDIT_VIEW row so the audit trail
 * records who looked at it. There is deliberately no update/delete endpoint.
 */
@ApiTags('audit')
@Controller('api/audit')
@RequireRoles(AppRole.AUDITOR)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary:
      'List audit rows, newest first, filterable by action/actor/department (AUDITOR only). ' +
      'Each read is itself recorded as an AUDIT_VIEW row.',
  })
  async list(
    @Query() query: ListAuditQueryDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<PaginatedAuditLog> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const result = await this.audit.list({
      action: query.action,
      actorUsername: query.actorUsername,
      department: query.department,
      page,
      pageSize,
    });

    await this.audit.record({
      action: AuditAction.AUDIT_VIEW,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'audit_log',
      meta: {
        page,
        pageSize,
        action: query.action ?? null,
        actorUsername: query.actorUsername ?? null,
        department: query.department ?? null,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }
}
