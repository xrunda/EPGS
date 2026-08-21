import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SyncStatusService } from './sync-status.service';

@Module({
  controllers: [SystemController],
  providers: [SyncStatusService],
})
export class SystemModule {}
