import { Module } from '@nestjs/common';
import { LevelConflictsController } from './level-conflicts.controller';
import { LevelConflictsService } from './level-conflicts.service';
import { AuditModule } from '../audit/audit.module';

/**
 * Issue #103. Imports AuditModule for the two writes; PrismaModule is global, so
 * the service gets PrismaService without an import here.
 *
 * The service reads MonitorService.DETAIL_INCLUDE (a static constant) rather than
 * importing MonitorModule: it needs the SELECT, not the service, and importing
 * the module would make the two features depend on each other at runtime for
 * nothing.
 */
@Module({
  imports: [AuditModule],
  controllers: [LevelConflictsController],
  providers: [LevelConflictsService],
  exports: [LevelConflictsService],
})
export class LevelConflictsModule {}
