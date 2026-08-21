import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MonitorService } from './monitor.service';
import { ListExamsQueryDto } from './dto/list-exams.query.dto';
import { SummaryQueryDto } from './dto/summary.query.dto';
import { MonitorExamDetailDto, MonitorSummaryDto, PaginatedMonitorExams } from '@epgs/shared-types';

/**
 * Read-only monitor workbench endpoints (issue #7). No write operations
 * exist on this controller by design - the product converged to read-only
 * display (issue #26): these endpoints surface the synced exam snapshot,
 * the attention level, and the hit evidence, and nothing else.
 */
@ApiTags('monitor')
@Controller('api/monitor')
export class MonitorController {
  constructor(private readonly monitorService: MonitorService) {}

  @Get('exams')
  @ApiOperation({
    summary:
      'List monitored exams with combined filters, sorting and pagination. ' +
      'Read-only display snapshot - never returns reportContent/diagnosis (see GET /api/monitor/exams/:id).',
  })
  list(@Query() query: ListExamsQueryDto): Promise<PaginatedMonitorExams> {
    return this.monitorService.list(query);
  }

  @Get('exams/:id')
  @ApiOperation({
    summary:
      'Get one exam full snapshot (including reportContent/diagnosis) and all hit evidence - the workbench detail drawer.',
  })
  getDetail(@Param('id', new ParseUUIDPipe()) id: string): Promise<MonitorExamDetailDto> {
    return this.monitorService.getDetail(id);
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Attention-level counts (total/red/yellow/green/unclassified) computed under the same filters as the list.',
  })
  summary(@Query() query: SummaryQueryDto): Promise<MonitorSummaryDto> {
    return this.monitorService.summary(query);
  }
}
