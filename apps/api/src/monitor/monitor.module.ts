import { Module } from '@nestjs/common';
import { MonitorController } from './monitor.controller';
import { MonitorService } from './monitor.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [MonitorController],
  providers: [MonitorService],
  // Issue #54: NotificationsModule renders notification templates from
  // MonitorService.summary (the single live counts source), so MonitorService
  // must be importable outside this module.
  exports: [MonitorService],
})
export class MonitorModule {}
