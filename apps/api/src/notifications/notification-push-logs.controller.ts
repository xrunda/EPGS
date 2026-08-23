import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginatedPushLogs } from '@epgs/shared-types';
import { NotificationRulesService } from './notification-rules.service';
import { ListPushLogsQueryDto } from './dto/list-push-logs.query.dto';

/**
 * Aggregated push-log listing (issue: logs as a first-level「日志」tab).
 * Lives in its own controller (path `api/notification-push-logs`) rather than
 * a `@Get('push-logs')` inside the rules controller, so it can never be
 * confused with the `:id` route. Read-only and open to any authenticated
 * user, mirroring `GET /api/notification-rules/:id/push-logs`.
 */
@ApiTags('notification-push-logs')
@Controller('api/notification-push-logs')
export class NotificationPushLogsController {
  constructor(private readonly rulesService: NotificationRulesService) {}

  @Get()
  @ApiOperation({
    summary: 'List push runs across all rules/templates, newest first, with per-channel deliveries.',
  })
  listAllPushLogs(@Query() query: ListPushLogsQueryDto): Promise<PaginatedPushLogs> {
    return this.rulesService.listAllPushLogs(query);
  }
}
