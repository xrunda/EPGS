import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Issue #13 audit trail. PrismaService is injected via the global
 * PrismaModule; AuditService is exported so feature modules (monitor/rules)
 * can record audit rows for their operations.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
