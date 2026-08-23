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
import { PaginatedNotificationChannels, NotificationChannelDto, TestSendResult } from '@epgs/shared-types';
import { NotificationsService } from './notifications.service';
import { NotificationTestSendService } from './notification-test-send.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ListChannelsQueryDto } from './dto/list-channels.query.dto';
import { TestSendDto } from './dto/test-send.dto';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';
import { NotificationSendException } from './errors/notification-send.exception';

/**
 * WeCom webhook channel management (issue #54, design §3/§5).
 *
 * Authorization: reads (GET) are open to any authenticated user; writes
 * (create/update/test-send) require SYSTEM_ADMIN. The actor on every written
 * row and audit entry is the authenticated username.
 *
 * SECURITY: the webhookUrl is encrypted at rest and never returned - reads
 * expose only `webhookUrlMasked`. Consequently audit meta contains only
 * `{name, isEnabled}` - never any webhook value. Test-send audit meta
 * contains the failure reason when WeCom rejects (code/message), but never
 * the rendered body (design §7).
 */
@ApiTags('notification-channels')
@Controller('api/notification-channels')
export class NotificationChannelsController {
  constructor(
    private readonly service: NotificationsService,
    private readonly testSendService: NotificationTestSendService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List WeCom notification channels, paginated. Webhook URLs are masked.' })
  list(@Query() query: ListChannelsQueryDto): Promise<PaginatedNotificationChannels> {
    return this.service.listChannels(query);
  }

  @Post()
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Create a WeCom notification channel (SYSTEM_ADMIN only).' })
  async create(
    @Body() dto: CreateChannelDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<NotificationChannelDto> {
    const result = await this.service.createChannel(dto, user?.username);
    await this.audit.record({
      action: AuditAction.CONFIG_CHANGE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_channel',
      resourceId: result.id,
      // Deliberately excludes any webhook value (design §5).
      meta: { name: result.name, isEnabled: result.isEnabled },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Put(':id')
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({
    summary:
      'Edit a WeCom notification channel. `webhookUrl` is write-only: when present it replaces the stored URL (re-encrypted); when absent the existing ciphertext is kept. (SYSTEM_ADMIN only)',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateChannelDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<NotificationChannelDto> {
    const result = await this.service.updateChannel(id, dto, user?.username);
    await this.audit.record({
      action: AuditAction.CONFIG_CHANGE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_channel',
      resourceId: id,
      meta: { name: result.name, isEnabled: result.isEnabled },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Post(':id/test-send')
  @HttpCode(HttpStatus.OK)
  @RequireRoles(AppRole.SYSTEM_ADMIN)
  @ApiOperation({
    summary:
      'Render a template with LIVE monitor counts + report date and push it to this channel (SYSTEM_ADMIN only). 200 = WeCom accepted; 502 = WeCom rejected/unreachable (details carry errcode/errmsg).',
  })
  async testSend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TestSendDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<TestSendResult> {
    const base = {
      action: AuditAction.NOTIFICATION_TEST_SEND,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'notification_channel',
      resourceId: id,
      ip: request.ip,
      correlationId: request.correlationId,
    };
    try {
      // Scope: the caller's department scope - empty = global, so a
      // scoped admin's test message reflects exactly what their scope sees.
      const result = await this.testSendService.send(id, dto.templateId, user?.departmentScope);
      await this.audit.record({
        ...base,
        meta: { channelId: id, templateId: dto.templateId, result: 'success', httpStatus: 200 },
      });
      return result;
    } catch (error) {
      // Only a real outbound failure gets a test-send audit row (design §7):
      // not-found/disabled never reached WeCom and are 4xx, not a failed send.
      if (error instanceof NotificationSendException) {
        const body = error.getResponse() as { details?: { wecomErrCode: number; wecomErrMsg: string } };
        await this.audit.record({
          ...base,
          meta: {
            channelId: id,
            templateId: dto.templateId,
            result: 'failure',
            httpStatus: 502,
            wecomErrCode: body.details?.wecomErrCode,
            wecomErrMsg: body.details?.wecomErrMsg,
          },
        });
      }
      throw error;
    }
  }
}
