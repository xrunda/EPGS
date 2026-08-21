import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncService } from './sync.service';
import { SystemClock } from './clock';
import { PacsAdapterModule } from '../pacs-adapter/pacs-adapter.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ScheduleModule.forRoot(), PacsAdapterModule, PrismaModule],
  providers: [SyncService, SystemClock],
  exports: [SyncService],
})
export class SyncModule {}
