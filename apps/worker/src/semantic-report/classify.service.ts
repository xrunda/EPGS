import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AttentionSemanticSnapshot,
  classifyReport,
  ClassifyReportDeps,
} from '@epgs/ai-semantic';
import {
  ClassifyApplyOutcome,
  ClassifyRecordCandidate,
  ClassifyReportStore,
} from './classify.store';
import { SEMANTIC_CLASSIFY_DEPS } from './semantic-report-model.factory';

/**
 * The report classifier loop (issue #88).
 *
 * WHAT IT IS: it reads a WHOLE report and asks a model which of the hospital's
 * configured attention semantics that report expresses - the meanings the
 * keyword engine cannot find, because they are not words. It then hands the
 * model's answer to deterministic code, which verifies every quoted excerpt
 * against the text actually sent, resolves every named semantic against the
 * configuration actually sent, computes the level from the COLORS the hospital
 * configured, and writes the result as a separate, additive audit trail.
 *
 * It never runs inside matching, never touches monitor_match, and never removes
 * anything. Its findings can only ADD a level where the keyword path found none.
 *
 * CADENCE: SEMANTIC_REPORT_INTERVAL_SECONDS (default 60), self-rescheduling
 * setTimeout - the next tick is scheduled only after the previous one settles,
 * so a slow model cannot make ticks overlap (same pattern as SyncService, the
 * push scheduler and #87's judge). A tick claims a bounded batch
 * (SEMANTIC_REPORT_BATCH_SIZE) rather than draining the queue, so the classifier
 * can never starve the sync job that shares this process. `classify:once` is the
 * manual full-drain tool.
 *
 * WHY THIS IS NOT PART OF THE SYNC TRANSACTION: same reason as #87, only more
 * so. A whole report is a much larger prompt than a sentence, so a network call
 * with a 20-second timeout inside the transaction that writes patient records
 * would hold locks across a slower call. Instead the record is committed first
 * and classified later; a classifier that is down leaves a growing backlog and a
 * fully working monitoring system.
 *
 * NO CONFIGURED SEMANTICS MEANS NO CLAIMING. When the hospital has not
 * configured (or has disabled) every attention semantic, the loop returns
 * without claiming anything and the backlog stays pending. This is deliberate:
 * claiming and resolving would drain the queue as "done" while there was nothing
 * to judge them against, and those reports would never be classified once the
 * hospital finally configured its semantics. `NO_SEMANTICS` in the task is the
 * race-only guard for a configuration that empties between the check and the
 * call.
 *
 * FAIL-SAFE, END TO END. Every failure below - disabled, unconfigured model,
 * no text, timeout, unparseable reply, unknown semantic, unverifiable evidence,
 * an incoherent level - ends with NO AI finding: the keyword result, #87's
 * filtering, the sync job and the notification flow are exactly what they would
 * have been. Nothing here can lower a level (the shared recompute takes a
 * maximum) and nothing here throws (a failure is an audit row, and this loop
 * cannot take the worker down).
 *
 * LOGGING CONTRACT: counts, ids, machine codes and timings only. Never report
 * text, never a prompt, never the model's free-text `reason`.
 */

/** What one pass did. Returned so callers (tick logs, `classify:once`) can report it. */
export interface ClassifyRunSummary {
  /** False when the classifier is switched off or unconfigured - every counter stays 0. */
  enabled: boolean;
  /**
   * True when the run found no enabled attention semantic and therefore claimed
   * nothing. Reported separately from `claimed: 0` because the two mean very
   * different things to an operator: one is "nothing to do", the other is
   * "the hospital has not configured this feature yet".
   */
  noSemantics: boolean;
  /** Records claimed from the queue this run. */
  claimed: number;
  /** Attempts that produced a usable, fully verified result (including "nothing applies"). */
  classified: number;
  /** Attempts that failed and therefore produced no AI finding (each is in the audit trail). */
  errored: number;
  /** Attempts that verified at least one attention semantic. */
  withMatches: number;
  /** Records drained terminally because they had already burned every allowed attempt. */
  exhausted: number;
  /** Records whose monitor_record.current_level moved as a result. */
  levelsChanged: number;
  /** Records still pending when the run ended. */
  pending: number;
}

@Injectable()
export class ClassifyReportService implements OnModuleInit {
  private readonly logger = new Logger(ClassifyReportService.name);
  /**
   * True only when the classifier is switched on AND the model settings are
   * complete - derived from `deps` rather than tracked separately so the two can
   * never disagree.
   */
  private readonly enabled: boolean;
  private readonly deps: ClassifyReportDeps | null;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Set once so "no semantics configured" is stated on the first pass, not every tick. */
  private warnedNoSemantics = false;

  constructor(
    private readonly config: ConfigService,
    private readonly store: ClassifyReportStore,
    @Optional()
    @Inject(SEMANTIC_CLASSIFY_DEPS)
    deps: ClassifyReportDeps | null = null,
  ) {
    this.batchSize = config.get<number>('semanticReportBatchSize', 5);
    this.maxAttempts = config.get<number>('semanticReportMaxAttempts', 3);
    this.leaseMs = config.get<number>('semanticReportLeaseSeconds', 600) * 1000;
    this.intervalMs = config.get<number>('semanticReportIntervalSeconds', 60) * 1000;

    // `deps` is the single source of truth: the module's factory returns null
    // when SEMANTIC_REPORT_ENABLED is not true, or when it is on but the model
    // settings are incomplete (having already logged which variables are
    // missing). Either way the loop does not start, and a deployment that has
    // not opted in behaves exactly as it did before #88: no queue scan, no model
    // call, no audit rows, every record's ai_* columns permanently NULL.
    this.deps = deps;
    this.enabled = deps !== null && deps !== undefined;
    if (this.deps === null) {
      this.logger.log(
        'report classifier not running - report levels are exactly the keyword levels',
      );
      return;
    }

    this.logger.log(
      `report classifier enabled: model=${this.deps.model} interval=${this.intervalMs / 1000}s ` +
        `batch=${this.batchSize} maxAttempts=${this.maxAttempts} lease=${this.leaseMs / 1000}s ` +
        `timeout=${this.deps.timeoutMs ?? 'default'}ms`,
    );
  }

  /** True only when the classifier is switched on AND fully configured. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.scheduleNext();
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    // unref so a pending tick never holds the process open at shutdown.
    this.timer.unref?.();
  }

  /**
   * One scheduled tick. This is the only place a failure is swallowed: a model
   * or database hiccup must not kill the loop, because the next tick can still
   * make progress and the API and sync job are unaffected either way.
   */
  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(
        `report classifier tick threw unexpectedly: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * One pass over the queue. Exported for `classify:once` and unit tests.
   *
   * Unlike `tick`, this does NOT swallow errors: a caller running it directly
   * (the CLI) needs a real failure to reach its exit code.
   *
   * @param options.maxBatches How many batches to claim before returning.
   *        Defaults to 1 - a tick must stay short to share the process fairly.
   */
  async runOnce(
    options: { maxBatches?: number; now?: Date } = {},
  ): Promise<ClassifyRunSummary> {
    const summary: ClassifyRunSummary = {
      enabled: this.enabled,
      noSemantics: false,
      claimed: 0,
      classified: 0,
      errored: 0,
      withMatches: 0,
      exhausted: 0,
      levelsChanged: 0,
      pending: 0,
    };

    const deps = this.deps;
    if (!this.enabled || deps === null) return summary;
    if (this.running) {
      this.logger.warn(
        'report classification requested while another run is already in progress in this process - skipping',
      );
      return summary;
    }
    this.running = true;
    try {
      const now = options.now ?? new Date();
      const maxBatches = Math.max(1, options.maxBatches ?? 1);

      // Drain records that already spent every attempt BEFORE claiming, so a
      // poison record cannot occupy a batch slot on every single tick.
      summary.exhausted = await this.store.resolveExhausted(now, this.maxAttempts);

      // Loaded once per run: every record in this pass is judged against the
      // same configuration, which is what makes configHash meaningful.
      const semantics = await this.store.loadEnabledSemantics();
      if (semantics.length === 0) {
        // Deliberately NOT claiming anything - see the class doc. The backlog
        // is classified as soon as the hospital configures its first semantic.
        summary.noSemantics = true;
        if (!this.warnedNoSemantics) {
          this.warnedNoSemantics = true;
          this.logger.warn(
            'report classifier is on but no attention semantic is enabled - no report will be ' +
              'classified and the backlog is left pending. Configure attention semantics ' +
              '(or load the preset templates) to start.',
          );
        }
        summary.pending = await this.store.countPending(this.maxAttempts);
        return summary;
      }
      this.warnedNoSemantics = false;

      for (let batch = 0; batch < maxBatches; batch += 1) {
        const candidates = await this.store.claimBatch({
          limit: this.batchSize,
          maxAttempts: this.maxAttempts,
          leaseMs: this.leaseMs,
          now,
        });
        if (candidates.length === 0) break;
        summary.claimed += candidates.length;

        for (const candidate of candidates) {
          // The level recompute happens inside applyResult's transaction, not
          // here: a record must never be visible with a level that disagrees
          // with the AI result that was just written. See classify.store.ts.
          const outcome = await this.classifyOne(candidate, semantics, deps, summary);
          summary.levelsChanged += outcome.levelsChanged;
        }

        // A short batch means the queue is drained; stop rather than paying for
        // an empty claim query.
        if (candidates.length < this.batchSize) break;
      }

      summary.pending = await this.store.countPending(this.maxAttempts);

      this.logger.log(
        `report classification run: claimed=${summary.claimed} classified=${summary.classified} ` +
          `errored=${summary.errored} withMatches=${summary.withMatches} ` +
          `exhausted=${summary.exhausted} levelsChanged=${summary.levelsChanged} ` +
          `pending=${summary.pending}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  /**
   * Classify one claimed record and persist the attempt. Returns what persisting
   * it did, so the run summary can report the level moves honestly.
   */
  private async classifyOne(
    candidate: ClassifyRecordCandidate,
    semantics: readonly AttentionSemanticSnapshot[],
    deps: ClassifyReportDeps,
    summary: ClassifyRunSummary,
  ): Promise<ClassifyApplyOutcome> {
    const result = await classifyReport(
      {
        examItem: candidate.examItem,
        reportContent: candidate.reportContent,
        diagnosis: candidate.diagnosis,
        semantics,
      },
      deps,
    );

    const outcome = await this.store.applyResult(candidate, result, new Date());

    if (result.outcome === 'OK') {
      summary.classified += 1;
      if (result.matches.length > 0) {
        summary.withMatches += 1;
        this.logger.log(
          `report classified: record=${candidate.monitorRecordId} ` +
            `level=${result.attentionLevel ?? 'n/a'} matches=${result.matches.length} ` +
            `semantics=${result.semanticCount}`,
        );
      }
    } else {
      summary.errored += 1;
      // Every one of these produced NO AI finding. Saying so explicitly matters:
      // "errored" must never read as "the monitor silently dropped something".
      this.logger.warn(
        `report classification attempt failed, no AI finding recorded: ` +
          `record=${candidate.monitorRecordId} code=${result.error}`,
      );
    }
    return outcome;
  }
}
