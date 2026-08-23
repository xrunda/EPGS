import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import {
  NotificationTemplateDto,
  NotificationTemplatePresetDto,
  NotificationVariableDto,
  PaginatedNotificationTemplates,
} from '@epgs/shared-types';
import { NotificationsService } from './notifications.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { ListTemplatesQueryDto } from './dto/list-templates.query.dto';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';

/**
 * Notification template management (issue #54, design §4).
 *
 * Authorization mirrors NotificationChannelsController: reads open to any
 * authenticated user, writes require SYSTEM_ADMIN. Audit meta on writes is
 * `{name, msgType, isEnabled}` - template CONTENT is config, not patient
 * data, but it still stays out of audit rows (design §7).
 */
@ApiTags('notification-templates')
@Controller('api/notification-templates')
export class NotificationTemplatesController {
  constructor(
    private readonly service: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('presets')
  @ApiOperation({
    summary: 'List preset content-template skeletons so operators do not start from a blank body (any authenticated user).',
  })
  presets(): NotificationTemplatePresetDto[] {
    return this.service.getPresets();
  }

  @Get('variables')
  @ApiOperation({
    summary: 'List the fixed {{placeholder}} dictionary available in template content (any authenticated user).',
  })
  variables(): NotificationVariableDto[] {
    return this.service.getVariables();
  }

  @Get()
  @ApiOperation({ summary: 'List notification templates, filterable by msgType/status, paginated.' })
  list(@Query() query: ListTemplatesQueryDto): Promise<PaginatedNotificationTemplates> {
    return this.service.listTemplates(query);
  }

  @Post()
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({
    summary:
      'Create a notification template (SYSTEM_ADMIN only). msgType NEWS requires titleTemplate (400 NOTIFICATION_TEMPLATE_TITLE_REQUIRED); a title submitted for TEXT is ignored.',
  })
  async create(
    @Body() dto: CreateTemplateDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<NotificationTemplateDto> {
    const result = await this.service.createTemplate(dto, user?.username);
    await this.audit.record({
      action: AuditAction.CONFIG_CHANGE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_template',
      resourceId: result.id,
      meta: { name: result.name, msgType: result.msgType, isEnabled: result.isEnabled },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Put(':id')
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({
    summary:
      'Edit a notification template. The NEWS-title-required rule is validated against the merged result. (SYSTEM_ADMIN only)',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<NotificationTemplateDto> {
    const result = await this.service.updateTemplate(id, dto, user?.username);
    await this.audit.record({
      action: AuditAction.CONFIG_CHANGE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_template',
      resourceId: id,
      meta: { name: result.name, msgType: result.msgType, isEnabled: result.isEnabled },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }
}
