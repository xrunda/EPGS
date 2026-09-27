import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SemanticJudgeStore } from './semantic-judge.store';
import { SemanticJudgeService } from './semantic-judge.service';
import {
  buildSemanticModelClient,
  readSemanticModelSettings,
  SEMANTIC_JUDGE_DEPS,
  SemanticJudgeDeps,
} from './semantic-model.factory';

/**
 * The AI semantic judge (issue #87) - the worker half.
 *
 * The judgement logic itself is @epgs/ai-semantic (framework- and DB-free); the
 * store is the Prisma adapter and the service is the loop.
 *
 * Deliberately built so that a deployment of this branch changes nothing until
 * someone opts in: with SEMANTIC_JUDGE_ENABLED unset the factory returns null,
 * the service logs why it is off, and no tick is ever scheduled - no queue
 * scan, no model call, no audit rows, keyword behaviour exactly as before.
 */
@Module({
  providers: [
    SemanticJudgeStore,
    {
      provide: SEMANTIC_JUDGE_DEPS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SemanticJudgeDeps => {
        if (!config.get<boolean>('semanticJudgeEnabled', false)) {
          // Off by default: return without complaint. A missing model URL on a
          // deployment that never asked for the judge is not an error.
          return null;
        }
        const { settings, missing } = readSemanticModelSettings(config);
        if (settings === null) {
          // Enabled but incomplete. Deliberately NOT a boot failure: this
          // process also runs the sync job that feeds patient monitoring, so
          // refusing to start over an optional AI layer's config would make the
          // AI a single point of failure for the whole system, which #87
          // forbids. Loud, and the judge stays off.
          new Logger('SemanticModule').error(
            `semantic judge requested but not configured - missing ${missing.join(', ')}; ` +
              'continuing with keyword matching only (no hit will be filtered)',
          );
          return null;
        }
        return {
          client: buildSemanticModelClient(settings),
          model: settings.model,
          timeoutMs: settings.timeoutMs,
          maxTokens: settings.maxTokens,
          contextCharBudget: settings.contextCharBudget,
        };
      },
    },
    SemanticJudgeService,
  ],
  exports: [SemanticJudgeService, SemanticJudgeStore],
})
export class SemanticModule {}
