import { Controller, Delete, Get, Param, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import {
  MonitorLevelConflictListDto,
  MonitorLevelConflictStateDto,
} from '@epgs/shared-types';
import { LevelConflictsService } from './level-conflicts.service';
import { ListLevelConflictsQueryDto } from './dto/list-level-conflicts.query.dto';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';

/**
 * Level-conflict todos for administrators (issue #103).
 *
 * WHAT THIS IS. A level conflict is one place in a report where the keyword path
 * and the report-level (AI) path both found something but asked for DIFFERENT
 * attention levels - a configuration disagreement a human has to settle. Until
 * now the product showed such a pair as two ordinary rows in one list, which
 * reads as "this report has two things worth reading" when the truth is "two
 * rules disagree about one thing". This surface is where an admin finds those
 * disagreements and records that they have looked at one.
 *
 * NOT A CLOSED LOOP (issue #26). Everything here is keyed by CONFIGURATION - a
 * rule group, a semantic group, a report column and two levels. No endpoint here
 * takes or returns a record id, a patient, a report body or a report's handling
 * state, and the stored flag means "an admin has read this configuration
 * problem", never "this patient's report was dealt with". That is why the
 * wording is 已读/未读 and why the routes say `read`, not anything in the
 * acknowledge/handle vocabulary the #26 red line removed.
 *
 * AUTHORIZATION: RULE_ADMIN for the whole controller, including the reads -
 * unlike /api/rules, where reads are open to any authenticated user. A conflict
 * is a configuration defect and the list is a work queue for the person who can
 * fix it; showing it to a doctor would be handing them a problem they cannot act
 * on. The class-level `@RequireRoles` is the fail-closed form: a route added
 * here later inherits it without anyone remembering to annotate it.
 *
 * AUDIT: both writes record an audit row. It carries the conflict key and the
 * two levels only - `resourceId` stays null because the column is a UUID and the
 * key is not one, and all of this is LOW-sensitivity configuration, not patient
 * data. Reads are not audited individually; the list endpoint is a configuration
 * view, and audit_log's value is in answering "who changed what state".
 */
@ApiTags('level-conflicts')
@Controller('api/monitor/level-conflicts')
@RequireRoles(AppRole.RULE_ADMIN)
export class LevelConflictsController {
  constructor(
    private readonly service: LevelConflictsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Level-conflict todos: places where the keyword rules and the report-level semantics disagree about the same spot in a report. Unread first. (RULE_ADMIN only)',
  })
  list(@Query() query: ListLevelConflictsQueryDto): Promise<MonitorLevelConflictListDto> {
    return this.service.list(query);
  }

  @Put(':conflictKey/read')
  @ApiOperation({
    summary:
      'Mark one level conflict read. Idempotent - marking it read again just moves the timestamp. (RULE_ADMIN only)',
  })
  async markRead(
    @Param('conflictKey') conflictKey: string,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<MonitorLevelConflictStateDto> {
    const result = await this.service.markRead(conflictKey, user?.username ?? null);
    await this.audit.record({
      action: AuditAction.MONITOR_LEVEL_CONFLICT_READ,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'monitor_level_conflict_read',
      // Null on purpose: the column is a Uuid and the conflict key is not one.
      // The key itself goes in `meta`, which is the LOW-sensitivity bag - and it
      // is configuration (two group ids, a column name and two levels), never
      // patient data.
      resourceId: null,
      meta: { conflictKey: result.conflictKey },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Delete(':conflictKey/read')
  @ApiOperation({
    summary:
      'Mark one level conflict unread. Idempotent in both directions - an unknown key succeeds, because the requested state now holds. (RULE_ADMIN only)',
  })
  async markUnread(
    @Param('conflictKey') conflictKey: string,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<MonitorLevelConflictStateDto> {
    const result = await this.service.markUnread(conflictKey, user?.username ?? null);
    await this.audit.record({
      action: AuditAction.MONITOR_LEVEL_CONFLICT_UNREAD,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'monitor_level_conflict_read',
      resourceId: null,
      meta: { conflictKey: result.conflictKey },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }
}
