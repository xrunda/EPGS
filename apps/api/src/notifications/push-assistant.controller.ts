import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import type { PushAssistantStatusDto } from '@epgs/shared-types';
import { RequireRoles } from '../access/access.decorators';
import { PushAssistantService } from './push-assistant.service';

/**
 * Push assistant status endpoint (issue #70). Read-only, polled by the web's
 * right-corner 推送助理 every ~5s. Open to any authenticated workbench role
 * (same set as the monitor controller) - the payload is aggregate-only
 * (counts, keywords, rule names, durations), never patient data, so no
 * per-department scoping is applied: the assistant always shows the全院
 * picture it will actually push (owner decision §4).
 *
 * The manual "立即推送" button reuses the existing
 * POST /api/notification-rules/:id/run (issue #61) - no new endpoint here.
 */
@ApiTags('notifications')
@Controller('api/notifications/assistant')
@RequireRoles(AppRole.VIEWER, AppRole.RULE_ADMIN, AppRole.SYSTEM_ADMIN)
export class PushAssistantController {
  constructor(private readonly assistant: PushAssistantService) {}

  @Get('status')
  @ApiOperation({
    summary:
      'Aggregated push-assistant status: liveness, next-push countdown, recent activity, upcoming-push preview, last run.',
  })
  getStatus(): Promise<PushAssistantStatusDto> {
    return this.assistant.getStatus();
  }
}
