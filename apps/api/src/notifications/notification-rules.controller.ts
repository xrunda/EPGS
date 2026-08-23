import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import {
  NotificationRuleDto,
  PaginatedNotificationRules,
  PaginatedPushLogs,
  RunNotificationRuleResult,
} from '@epgs/shared-types';
import { NotificationRulesService } from './notification-rules.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { ListRulesQueryDto } from './dto/list-rules.query.dto';
import { ListPushLogsQueryDto } from './dto/list-push-logs.query.dto';
import { RunRuleQueryDto } from './dto/run-rule.query.dto';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';

/**
 * Scheduled push-rule management + manual "run now" (issue: push rules).
 *
 * Authorization mirrors the channel/template controllers: reads open to any
 * authenticated user, writes and manual runs require SYSTEM_ADMIN. CRUD audit
 * is CONFIG_CHANGE with `{name, cron, isEnabled}` meta; a manual run records
 * NOTIFICATION_RULE_RUN with the targeted window date + aggregate outcome.
 * Cron expressions and channel bindings are config, not patient data, so they
 * are safe in audit meta (design §7).
 */
@ApiTags('notification-rules')
@Controller('api/notification-rules')
export class NotificationRulesController {
  constructor(
    private readonly service: NotificationRulesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List scheduled push rules, filterable by enabled/disabled status, paginated.' })
  list(@Query() query: ListRulesQueryDto): Promise<PaginatedNotificationRules> {
    return this.service.listRules(query);
  }

  @Post()
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({
    summary:
      'Create a scheduled push rule: picks a template, one or more channels, and a 5-field Asia/Shanghai cron (SYSTEM_ADMIN only).',
  })
  async create(
    @Body() dto: CreateRuleDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<NotificationRuleDto> {
    const result = await this.service.createRule(dto, user?.username);
    await this.audit.record({
      action: AuditAction.CONFIG_CHANGE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_rule',
      resourceId: result.id,
      meta: {
        name: result.name,
        cron: result.cron,
        templateId: result.templateId,
        channelIds: result.channels.map((channel) => channel.channelId),
        isEnabled: result.isEnabled,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one push rule by id (any authenticated user).' })
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<NotificationRuleDto> {
    return this.service.getRule(id);
  }

  @Put(':id')
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({
    summary:
      'Edit a push rule. `channelIds` when present replaces the whole channel binding set. (SYSTEM_ADMIN only)',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRuleDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<NotificationRuleDto> {
    const result = await this.service.updateRule(id, dto, user?.username);
    await this.audit.record({
      action: AuditAction.CONFIG_CHANGE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_rule',
      resourceId: id,
      meta: {
        name: result.name,
        cron: result.cron,
        templateId: result.templateId,
        channelIds: result.channels.map((channel) => channel.channelId),
        isEnabled: result.isEnabled,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({
    summary:
      'Manually run a push rule once now (SYSTEM_ADMIN only). Always allowed - idempotency only constrains SCHEDULED runs. `windowDate` defaults to today (Asia/Shanghai) and also enables historical re-push.',
  })
  async run(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: RunRuleQueryDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<RunNotificationRuleResult> {
    const result = await this.service.runRule(id, query.windowDate, user?.departmentScope);
    await this.audit.record({
      action: AuditAction.NOTIFICATION_RULE_RUN,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_rule',
      resourceId: id,
      // The executor resolves the window; surface it here so the audit row
      // shows the date actually pushed (the caller may have omitted it).
      meta: {
        result: result.alreadyPushed ? 'already_pushed' : 'executed',
        status: result.status,
        pushLogId: result.pushLogId,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Get(':id/push-logs')
  @ApiOperation({ summary: 'List a rule’s push runs (scheduled + manual), newest first, with per-channel deliveries.' })
  listPushLogs(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListPushLogsQueryDto,
  ): Promise<PaginatedPushLogs> {
    return this.service.listPushLogs(id, query);
  }
}
