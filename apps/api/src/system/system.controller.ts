import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SyncStatusDto } from '@epgs/shared-types';
import { SyncStatusService } from './sync-status.service';

@ApiTags('system')
@Controller('api/system')
export class SystemController {
  constructor(private readonly syncStatusService: SyncStatusService) {}

  @Get('sync-status')
  @ApiOperation({
    summary:
      'Reports the PACS/RIS incremental sync job health (issue #6): last success time, resume cursor, ' +
      'read/success/failure counts, and a sanitized error summary. Reads sync_job_log directly - ' +
      'apps/api and apps/worker share the same Postgres database, so no worker-side RPC is needed.',
  })
  getSyncStatus(): Promise<SyncStatusDto> {
    return this.syncStatusService.getStatus();
  }
}
