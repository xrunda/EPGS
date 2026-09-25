import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClassifyReportStore } from './classify.store';
import { ClassifyReportService } from './classify.service';
import { readClassifyReportDeps, SEMANTIC_CLASSIFY_DEPS } from './semantic-report-model.factory';

/**
 * The AI report classifier (issue #88) - the worker half.
 *
 * The classification logic itself is @epgs/ai-semantic (framework- and
 * DB-free); the store is the Prisma adapter and the service is the loop.
 *
 * SEPARATE FROM SemanticModule (#87), and deliberately so. The two tasks have
 * independent switches (SEMANTIC_JUDGE_ENABLED / SEMANTIC_REPORT_ENABLED),
 * independent queues and independent failure directions: #87 can REMOVE a
 * keyword hit, #88 can only ADD a finding. Sharing a module would couple two
 * rollouts that a hospital may well want to stagger - and would make "turn the
 * judge on, leave the classifier off" impossible to express.
 *
 * Built so that a deployment of this branch changes nothing until someone opts
 * in: with SEMANTIC_REPORT_ENABLED unset the factory returns null, the service
 * logs why it is off, no tick is ever scheduled, and every `ai_*` column stays
 * NULL - so `current_level` is exactly the keyword level it was before #88.
 */
@Module({
  providers: [
    ClassifyReportStore,
    {
      provide: SEMANTIC_CLASSIFY_DEPS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (!config.get<boolean>('semanticReportEnabled', false)) {
          // Off by default: return without complaint. A missing model URL on a
          // deployment that never asked for report classification is not an error.
          return null;
        }
        const { deps, missing } = readClassifyReportDeps(config);
        if (deps === null) {
          // Enabled but incomplete. Deliberately NOT a boot failure - see the
          // module doc and semantic-model.factory.ts. Loud, and the classifier
          // stays off; every report keeps its keyword level.
          new Logger('SemanticReportModule').error(
            `report classifier requested but not configured - missing ${missing.join(', ')}; ` +
              'continuing with keyword matching only (no report will be classified)',
          );
          return null;
        }
        return deps;
      },
    },
    ClassifyReportService,
  ],
  exports: [ClassifyReportService, ClassifyReportStore],
})
export class SemanticReportModule {}
