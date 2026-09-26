import { Module } from '@nestjs/common';
import { AttentionSemanticsController } from './attention-semantics.controller';
import { AttentionSemanticsService } from './attention-semantics.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [AttentionSemanticsController],
  providers: [AttentionSemanticsService],
  exports: [AttentionSemanticsService],
})
export class AttentionSemanticsModule {}
