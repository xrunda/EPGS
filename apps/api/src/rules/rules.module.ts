import { Module } from '@nestjs/common';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import { RulesImportService } from './import/rules-import.service';
import { ImportStagingStore } from './import/import-staging.store';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [RulesController],
  providers: [RulesService, RulesImportService, ImportStagingStore],
  exports: [RulesService],
})
export class RulesModule {}
