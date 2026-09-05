import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AlertLinkExamListDto,
  AlertLinkSummaryDto,
  MonitorExamDetailDto,
} from '@epgs/shared-types';
import { Public } from '../auth/public.decorator';
import { AlertLinkGuard } from './alert-link.guard';
import { AlertLinksService } from './alert-links.service';
import { AlertLinkRequest, ResolvedAlertLink } from './alert-link.types';

/**
 * Endpoints behind the WeCom alert H5 page (issue #72). `@Public()` bypasses
 * the cookie-session AuthGuard/RolesGuard; AlertLinkGuard then requires
 * `Authorization: Bearer <link token>` and attaches the resolved link. All
 * routes are read-only and narrowed to the link's frozen record ids.
 */
@ApiTags('alert-links')
@Controller('api/alert-links')
@Public()
@UseGuards(AlertLinkGuard)
export class AlertLinksController {
  constructor(private readonly service: AlertLinksService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Resolve the alert link behind the Bearer token: level, window date, record count, expiry. Counts as one open.',
  })
  open(@Req() request: AlertLinkRequest): Promise<AlertLinkSummaryDto> {
    return this.service.open(linkOf(request));
  }

  @Get('me/exams')
  @ApiOperation({
    summary: 'The link’s frozen patient list (names masked, bed/department kept; no report body).',
  })
  list(@Req() request: AlertLinkRequest): Promise<AlertLinkExamListDto> {
    return this.service.listExams(linkOf(request));
  }

  @Get('me/exams/:id')
  @ApiOperation({
    summary:
      'One snapshot record’s detail (name masked; report body + hit evidence kept). 404 for ids outside the link.',
  })
  detail(
    @Req() request: AlertLinkRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MonitorExamDetailDto> {
    return this.service.getExamDetail(linkOf(request), id);
  }
}

function linkOf(request: AlertLinkRequest): ResolvedAlertLink {
  // AlertLinkGuard always sets this for the routes above; a missing value
  // would mean the guard was removed, which must fail loudly, not leak.
  if (!request.alertLink) throw new Error('AlertLinkGuard did not resolve a link');
  return request.alertLink;
}
