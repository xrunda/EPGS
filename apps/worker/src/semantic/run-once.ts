import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppModule } from '../app.module';
import { SemanticJudgeService } from './semantic-judge.service';
import { SemanticJudgeStore } from './semantic-judge.store';

/**
 * Manual drain of the semantic judge queue (issue #87), run as
 * `pnpm --filter @epgs/worker run semantic:once`.
 *
 * WHY A TOOL AND NOT JUST THE LOOP: the scheduled tick is deliberately capped
 * at SEMANTIC_JUDGE_BATCH_SIZE per run so it can share the process with the
 * sync job. After switching the judge on there is a backlog - every keyword hit
 * recorded since the rule gained a semantic intent - and waiting for 10 hits
 * every 30 seconds to work through it is not an operator's idea of a rollout.
 * This runs the same `runOnce` the tick uses, with the batch cap lifted.
 *
 * Same trust model as sync:once / reclassify:once: a CLI requiring shell access
 * to the worker's runtime, not an HTTP endpoint - no new attack surface, real
 * DI wiring.
 *
 * USAGE
 *   semantic:once                                  drain what is pending
 *   semantic:once -- --max-batches=500             bound the drain
 *   semantic:once -- --rejudge --rule-group=<uuid> re-judge already-judged hits
 *
 * `--rejudge` REQUIRES a scope (--rule-group, --record or --since). It puts
 * resolved hits back in the queue, and each one costs a model call; an
 * unscoped re-judge would spend the entire match table's worth of calls because
 * someone typed one flag. The scope is not a convenience, it is the guard.
 *
 * A re-judged hit is judged against the intent text on the rule version it
 * matched with - the same frozen version the first judgement used, whose text
 * the audit row's inputHash commits to. So re-judging after EDITING a rule's
 * intent does not apply the new intent to old hits: editing the intent creates
 * a new rule version, and the old hits keep pointing at the old one. That is
 * this repository's documented rule-edit semantics (a rule change affects new
 * data), and the honest alternative would be an audit row whose hash no longer
 * verifies. What this flag IS for: re-running after a fix to the judge itself,
 * and retrying hits whose attempts were exhausted while the gateway was down.
 */
interface Options {
  maxBatches: number;
  rejudge: boolean;
  ruleGroup?: string;
  record?: string;
  since?: Date;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    // Effectively unbounded: a backlog drain should finish. The loop still
    // stops on its own when a batch comes back short.
    maxBatches: 100_000,
    rejudge: false,
  };

  for (const arg of argv) {
    if (arg === '--rejudge') {
      options.rejudge = true;
    } else if (arg.startsWith('--max-batches=')) {
      const parsed = Number.parseInt(arg.slice('--max-batches='.length), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--max-batches must be a positive integer');
      }
      options.maxBatches = parsed;
    } else if (arg.startsWith('--rule-group=')) {
      options.ruleGroup = arg.slice('--rule-group='.length);
    } else if (arg.startsWith('--record=')) {
      options.record = arg.slice('--record='.length);
    } else if (arg.startsWith('--since=')) {
      const raw = arg.slice('--since='.length);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--since is not a valid date: ${raw}`);
      }
      options.since = parsed;
    } else {
      throw new Error(`unrecognised argument: ${arg}`);
    }
  }

  if (
    options.rejudge &&
    options.ruleGroup === undefined &&
    options.record === undefined &&
    options.since === undefined
  ) {
    throw new Error(
      '--rejudge requires a scope: --rule-group=<uuid>, --record=<uuid> or --since=<ISO date> ' +
        '(each re-judged hit costs a model call)',
    );
  }
  return options;
}

function rejudgeScope(options: Options): Prisma.MonitorMatchWhereInput {
  const where: Prisma.MonitorMatchWhereInput = {};
  if (options.ruleGroup !== undefined) where.rule = { ruleGroupId: options.ruleGroup };
  if (options.record !== undefined) where.monitorRecordId = options.record;
  if (options.since !== undefined) where.matchedAt = { gte: options.since };
  return where;
}

async function main(): Promise<void> {
  const logger = new Logger('semantic:once');
  const options = parseOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const service = app.get(SemanticJudgeService);
    if (!service.isEnabled) {
      // Not a silent no-op: an operator who ran this expects work to happen, and
      // "the judge is off" is the single most likely reason nothing did.
      throw new Error(
        'the semantic judge is disabled or unconfigured - set SEMANTIC_JUDGE_ENABLED=true and ' +
          'SEMANTIC_MODEL_BASE_URL / SEMANTIC_MODEL_NAME (see .env.example), then re-run',
      );
    }

    if (options.rejudge) {
      const store = app.get(SemanticJudgeStore);
      const requeued = await store.requeue(rejudgeScope(options));
      logger.log(
        `requeued ${requeued} resolved hit(s) for re-judgement ` +
          `(ruleGroup=${options.ruleGroup ?? '-'} record=${options.record ?? '-'} since=${options.since?.toISOString() ?? '-'})`,
      );
    }

    const summary = await service.runOnce({ maxBatches: options.maxBatches });
    logger.log(
      `semantic:once finished claimed=${summary.claimed} judged=${summary.judged} ` +
        `errored=${summary.errored} skipped=${summary.skipped} exhausted=${summary.exhausted} ` +
        `filtered=${summary.filtered} levelsChanged=${summary.levelsChanged} pending=${summary.pending}`,
    );
    if (summary.errored > 0) {
      // Every errored hit was KEPT (fail-open). Saying so explicitly matters:
      // "errored" must never read as "the monitor silently dropped something".
      logger.warn(
        `${summary.errored} attempt(s) failed and kept their keyword hit - ` +
          'see the monitor_match_semantic rows for the failure codes',
      );
    }
    if (summary.pending > 0) {
      logger.log(`${summary.pending} hit(s) still pending; re-run to continue`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      message: `semantic:once failed to run: ${err instanceof Error ? err.message : 'unknown error'}`,
    }),
  );
  process.exitCode = 1;
});
