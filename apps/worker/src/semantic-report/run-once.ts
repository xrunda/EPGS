import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppModule } from '../app.module';
import { ClassifyReportService } from './classify.service';
import { ClassifyReportStore } from './classify.store';

/**
 * Manual drain of the report classifier queue (issue #88), run as
 * `pnpm --filter @epgs/worker run classify:once`.
 *
 * WHY A TOOL AND NOT JUST THE LOOP: the scheduled tick is capped at
 * SEMANTIC_REPORT_BATCH_SIZE so it can share the process with the sync job.
 * Switching the classifier on is exactly when there is a backlog - every report
 * synced since the records were created - and waiting for 5 reports a minute is
 * not an operator's idea of a rollout. This runs the same `runOnce` the tick
 * uses, with the batch cap lifted.
 *
 * Same trust model as semantic:once / sync:once: a CLI requiring shell access to
 * the worker's runtime, not an HTTP endpoint - no new attack surface, real DI
 * wiring.
 *
 * USAGE
 *   classify:once                                   drain what is pending
 *   classify:once -- --max-batches=500              bound the drain
 *   classify:once -- --requeue --record=<uuid>      re-classify one record
 *   classify:once -- --requeue --since=<ISO date>   re-classify a time range
 *
 * `--requeue` REQUIRES a scope (--record or --since). It puts resolved records
 * back in the queue, and each one costs a model call on a whole report; an
 * unscoped re-run would spend the entire record table's worth of calls because
 * someone typed one flag. The scope is not a convenience, it is the guard.
 *
 * A re-classified record is judged against the CURRENT enabled attention
 * semantics - unlike #87's re-judge, which uses the frozen intent on the rule
 * version the hit matched with. That difference is deliberate: a hit's rule
 * version is fixed by the match row, whereas a record is not tied to any
 * semantic version, and `configHash` on the new audit row records exactly which
 * configuration produced it. So re-classifying after editing the semantics
 * genuinely re-judges against the new configuration - which is precisely what
 * this flag is for, alongside retrying records whose attempts were exhausted
 * while the gateway was down.
 *
 * Only RESOLVED records are requeued (the store enforces it), so this cannot
 * double-classify work that is still in flight.
 */
interface Options {
  maxBatches: number;
  requeue: boolean;
  record?: string;
  since?: Date;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    // Effectively unbounded: a backlog drain should finish. The loop still
    // stops on its own when a batch comes back short.
    maxBatches: 100_000,
    requeue: false,
  };

  for (const arg of argv) {
    if (arg === '--requeue') {
      options.requeue = true;
    } else if (arg.startsWith('--max-batches=')) {
      const parsed = Number.parseInt(arg.slice('--max-batches='.length), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--max-batches must be a positive integer');
      }
      options.maxBatches = parsed;
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

  if (options.requeue && options.record === undefined && options.since === undefined) {
    throw new Error(
      '--requeue requires a scope: --record=<uuid> or --since=<ISO date> ' +
        '(each re-classified report costs a model call)',
    );
  }
  return options;
}

/**
 * `examTime` is the scope for --since, not `createdAt`: an operator means "the
 * reports from this period", which is what the queue itself orders by, and it is
 * the field an auditor can see in the workbench.
 */
function requeueScope(options: Options): Prisma.MonitorRecordWhereInput {
  const where: Prisma.MonitorRecordWhereInput = {};
  if (options.record !== undefined) where.id = options.record;
  if (options.since !== undefined) where.examTime = { gte: options.since };
  return where;
}

async function main(): Promise<void> {
  const logger = new Logger('classify:once');
  const options = parseOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const service = app.get(ClassifyReportService);
    if (!service.isEnabled) {
      // Not a silent no-op: an operator who ran this expects work to happen, and
      // "the classifier is off" is the single most likely reason nothing did.
      throw new Error(
        'the report classifier is disabled or unconfigured - set SEMANTIC_REPORT_ENABLED=true and ' +
          'SEMANTIC_MODEL_BASE_URL / SEMANTIC_MODEL_NAME (see .env.example), then re-run',
      );
    }

    if (options.requeue) {
      const store = app.get(ClassifyReportStore);
      const requeued = await store.requeue(requeueScope(options));
      logger.log(
        `requeued ${requeued} resolved record(s) for re-classification ` +
          `(record=${options.record ?? '-'} since=${options.since?.toISOString() ?? '-'})`,
      );
    }

    const summary = await service.runOnce({ maxBatches: options.maxBatches });
    logger.log(
      `classify:once finished claimed=${summary.claimed} classified=${summary.classified} ` +
        `errored=${summary.errored} withMatches=${summary.withMatches} ` +
        `exhausted=${summary.exhausted} levelsChanged=${summary.levelsChanged} ` +
        `pending=${summary.pending}`,
    );
    if (summary.noSemantics) {
      // The single most confusing outcome for an operator: the tool ran, did
      // nothing, and reported no error. Say why, and say what to do.
      logger.warn(
        'no attention semantic is enabled, so nothing was classified and the backlog was left ' +
          'pending - configure attention semantics (or load the preset templates) and re-run',
      );
    }
    if (summary.errored > 0) {
      // Every errored record got NO AI finding and kept its keyword level
      // exactly as it was. Saying so explicitly matters: "errored" must never
      // read as "the monitor silently dropped something".
      logger.warn(
        `${summary.errored} attempt(s) failed and produced no AI finding - ` +
          'see the monitor_report_ai rows for the failure codes',
      );
    }
    if (summary.withMatches > 0) {
      logger.log(
        `${summary.withMatches} record(s) gained an AI finding; ` +
          `${summary.levelsChanged} record level(s) moved`,
      );
    }
    if (summary.pending > 0) {
      logger.log(`${summary.pending} record(s) still pending; re-run to continue`);
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
      message: `classify:once failed to run: ${err instanceof Error ? err.message : 'unknown error'}`,
    }),
  );
  process.exitCode = 1;
});
