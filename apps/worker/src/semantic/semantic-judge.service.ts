import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  deriveOccurrences,
  semanticIntentConfigured,
  validateMatch,
  ValidateMatchDeps,
} from '@epgs/ai-semantic';
import { SemanticJudgeCandidate, SemanticJudgeStore } from './semantic-judge.store';
import { SEMANTIC_JUDGE_DEPS, SemanticJudgeDeps } from './semantic-model.factory';

/**
 * The semantic judge loop (issue #87).
 *
 * WHAT IT IS: after the deterministic keyword engine has already recorded a
 * `monitor_match` row, this loop reads that hit's local context and asks a
 * model what the sentence MEANS - then lets deterministic code decide whether
 * the hit still counts. It never runs inside matching, never sees or sets a
 * red/yellow/green level, and never changes what the keyword engine recorded:
 * the raw hit, its level and its snippet are exactly as the engine left them,
 * and the AI verdict is a separate, additive audit trail linked to the hit.
 * That ordering is the point of the whole design. A hit is created first, by
 * code, unconditionally; the judge only ever annotates it afterwards.
 *
 * CADENCE: SEMANTIC_JUDGE_INTERVAL_SECONDS (default 30), self-rescheduling
 * setTimeout - the next tick is scheduled only after the previous one settles,
 * so a slow model cannot make ticks overlap (same pattern and rationale as
 * SyncService and NotificationScheduler). A tick claims a bounded batch
 * (SEMANTIC_JUDGE_BATCH_SIZE) rather than draining the queue, so the judge can
 * never starve the sync job that shares this process. `semantic:once` is the
 * manual full-drain tool.
 *
 * WHY THIS IS NOT PART OF THE SYNC TRANSACTION: judging inside
 * `sync-runner.ts` would put a network call with a multi-second timeout inside
 * the transaction that writes patient matches, so a slow or hanging model
 * would slow - or, on lock timeout, fail - patient monitoring itself. It would
 * also mean a hit only exists if the model answered, destroying both the audit
 * requirement (the raw match must be preserved) and the fail-open requirement.
 * Instead the hit is committed first and judged later; a judge that is down
 * leaves a growing backlog and a fully working monitoring system. The backlog
 * is bounded by construction rather than by hope: the queue is drained
 * oldest-first, and a row that fails MAX_ATTEMPTS times is resolved terminally
 * and fail-open instead of retried forever.
 *
 * FAIL-OPEN, END TO END. Every failure below - disabled, unconfigured, model
 * error, timeout, unparseable reply, unverifiable evidence, no context - ends
 * with the original keyword hit still standing, because `validateMatch` has no
 * branch that can produce `filtered: true` from a failure and the store only
 * writes what that function returned. The failure is recorded (an audit row
 * and a log line naming a machine code), never thrown: this loop cannot take
 * the worker down.
 *
 * LOGGING CONTRACT: counts, ids, model/decision machine codes and timings
 * only. Never report text, never the context excerpt, never the model's
 * free-text `reason` - it is persisted for the audit trail (where access
 * control applies) but logs are a second, less-guarded copy, and a model that
 * quotes the report into its explanation would put patient text in them.
 */

/** What one pass did. Returned so callers (tick logs, `semantic:once`) can report it. */
export interface SemanticRunSummary {
  /** False when the judge is switched off or unconfigured - every counter stays 0. */
  enabled: boolean;
  /** Rows claimed from the queue this run. */
  claimed: number;
  /** Attempts that produced a usable, verified verdict. */
  judged: number;
  /** Attempts that failed and therefore kept the hit (each one is in the audit trail). */
  errored: number;
  /** Rows taken out of the queue unjudged: no semantic intent, or no text source. */
  skipped: number;
  /**
   * Rows resolved terminally because they had already burned every allowed
   * attempt. Not judged this run - drained so the queue does not stall on them.
   */
  exhausted: number;
  /** Hits the decision matrix removed from the effective result. */
  filtered: number;
  /** Records whose monitor_record.current_level moved as a result. */
  levelsChanged: number;
  /** Hits still pending when the run ended. */
  pending: number;
}

/**
 * A deliberately unusable anchor (end <= start is rejected by
 * buildContextWindow) used when no real anchor can be found.
 *
 * It routes such a hit through the task's documented EMPTY_CONTEXT path - which
 * keeps the hit and records an audit row saying exactly that - instead of
 * silently skipping it. "We could not build a context for this hit" is a fact
 * worth one row in the trail, and it is the honest answer for a match whose
 * report has since changed underneath it.
 */
const UNUSABLE_ANCHOR = 0;

@Injectable()
export class SemanticJudgeService implements OnModuleInit {
  private readonly logger = new Logger(SemanticJudgeService.name);
  /**
   * True only when the judge is switched on AND fully configured - i.e. exactly
   * when `deps` is non-null, derived from it rather than tracked separately so
   * the two can never disagree.
   */
  private readonly enabled: boolean;
  private readonly deps: SemanticJudgeDeps;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly store: SemanticJudgeStore,
    @Optional()
    @Inject(SEMANTIC_JUDGE_DEPS)
    deps: SemanticJudgeDeps = null,
  ) {
    this.batchSize = config.get<number>('semanticJudgeBatchSize', 10);
    this.maxAttempts = config.get<number>('semanticJudgeMaxAttempts', 3);
    this.leaseMs = config.get<number>('semanticJudgeLeaseSeconds', 300) * 1000;
    this.intervalMs = config.get<number>('semanticJudgeIntervalSeconds', 30) * 1000;

    // `deps` is the single source of truth: the module's factory returns null
    // when the judge is off (SEMANTIC_JUDGE_ENABLED is not true) or when it is
    // on but the model settings are incomplete, having already logged which
    // variables are missing. Either way the loop does not start and a
    // deployment that has not opted in is byte-identical to pre-#87 behaviour:
    // no queue scan, no model call, no audit rows.
    this.deps = deps;
    this.enabled = deps !== null && deps !== undefined;
    if (deps === null || deps === undefined) {
      this.logger.log('semantic judge not running - keyword hits stand exactly as recorded');
      return;
    }

    this.logger.log(
      `semantic judge enabled: model=${deps.model} interval=${this.intervalMs / 1000}s ` +
        `batch=${this.batchSize} maxAttempts=${this.maxAttempts} ` +
        `lease=${this.leaseMs / 1000}s timeout=${deps.timeoutMs ?? 10_000}ms`,
    );
  }

  /** True only when the judge is switched on AND fully configured. */
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
    // unref so a pending tick never holds the process open at shutdown,
    // same as the push scheduler's timer.
    this.timer.unref?.();
  }

  /**
   * One scheduled tick. This is the only place a failure is swallowed: a model
   * or database hiccup must not kill the loop, because the next tick can still
   * make progress and the API / sync job are unaffected either way.
   */
  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(
        `semantic judge tick threw unexpectedly: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * One pass over the queue. Exported for `semantic:once` and unit tests.
   *
   * Unlike `tick`, this does NOT swallow errors: a caller running it directly
   * (the CLI) needs a real failure to reach its exit code. The tick wrapper
   * above is what makes the loop resilient.
   *
   * @param options.maxBatches How many batches to claim before returning.
   *        Defaults to 1 - a tick must stay short to share the process fairly.
   *        The CLI passes a large number to drain a backlog.
   */
  async runOnce(options: { maxBatches?: number; now?: Date } = {}): Promise<SemanticRunSummary> {
    const summary: SemanticRunSummary = {
      enabled: this.enabled,
      claimed: 0,
      judged: 0,
      errored: 0,
      skipped: 0,
      exhausted: 0,
      filtered: 0,
      levelsChanged: 0,
      pending: 0,
    };

    const deps = this.deps;
    if (!this.enabled || deps === null) return summary;
    if (this.running) {
      this.logger.warn(
        'semantic run requested while another run is already in progress in this process - skipping',
      );
      return summary;
    }
    this.running = true;
    try {
      const now = options.now ?? new Date();
      const maxBatches = Math.max(1, options.maxBatches ?? 1);

      // Drain rows that already spent every attempt BEFORE claiming, so a
      // poison row cannot occupy a batch slot on every single tick.
      summary.exhausted = await this.store.resolveExhausted(now, this.maxAttempts);

      for (let batch = 0; batch < maxBatches; batch += 1) {
        const candidates = await this.store.claimBatch({
          limit: this.batchSize,
          maxAttempts: this.maxAttempts,
          leaseMs: this.leaseMs,
          now,
        });
        if (candidates.length === 0) break;
        summary.claimed += candidates.length;

        const affectedRecords = new Set<string>();
        for (const candidate of candidates) {
          const resolved = await this.judgeOne(candidate, deps, summary);
          if (resolved) affectedRecords.add(candidate.monitorRecordId);
        }

        // After the batch, not per row: one GROUP BY per affected record
        // instead of one per verdict, and the level is computed against a set
        // of verdicts that has already stopped moving.
        //
        // Recomputed for KEPT hits too, not just filtered ones. Skipping the
        // recompute when nothing was filtered would look like a free
        // optimization and would be a bug: `semantic:once --rejudge` puts a
        // previously FILTERED row back in the queue, and a re-judgement that
        // keeps it has to raise the record's level back up.
        summary.levelsChanged += await this.store.recomputeLevels([...affectedRecords]);

        // A short batch means the queue is drained; stop rather than paying
        // for an empty claim query.
        if (candidates.length < this.batchSize) break;
      }

      summary.pending = await this.store.countPending(this.maxAttempts);

      this.logger.log(
        `semantic run: claimed=${summary.claimed} judged=${summary.judged} errored=${summary.errored} ` +
          `skipped=${summary.skipped} exhausted=${summary.exhausted} filtered=${summary.filtered} ` +
          `levelsChanged=${summary.levelsChanged} pending=${summary.pending}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  /**
   * Judge one claimed hit: decide whether it is judgeable at all, run the task,
   * persist the attempt, and report whether the row was resolved HERE (which is
   * what makes its record's level worth recomputing).
   */
  private async judgeOne(
    candidate: SemanticJudgeCandidate,
    deps: ValidateMatchDeps,
    summary: SemanticRunSummary,
  ): Promise<boolean> {
    const at = new Date();

    // A rule with no semantic intent is not "an AI judgement that failed" - it
    // is a rule the doctor has not configured, and it must behave exactly as it
    // did before #87: no model call, no audit row.
    if (!semanticIntentConfigured(candidate.semanticIntent)) {
      if (await this.store.resolveSkipped(candidate.matchId, at)) summary.skipped += 1;
      return false;
    }

    // No text source for this field (see fieldTextFor). Nothing to read, so
    // nothing to judge; the hit stands.
    if (candidate.fieldText === null) {
      if (await this.store.resolveSkipped(candidate.matchId, at)) summary.skipped += 1;
      return false;
    }

    const anchor = this.resolveAnchor(candidate);
    const result = await validateMatch(
      {
        keyword: candidate.keyword,
        semanticIntent: candidate.semanticIntent ?? '',
        fieldText: candidate.fieldText,
        matchStart: anchor?.start ?? UNUSABLE_ANCHOR,
        matchEnd: anchor?.end ?? UNUSABLE_ANCHOR,
        matchField: candidate.matchField,
        matchMode: candidate.matchMode,
        reportVersion: candidate.reportVersion,
        // siblingOccurrences deliberately omitted: the task re-derives every
        // other occurrence of the keyword itself, using the same strategies the
        // matcher uses. Passing them in from here would be a second
        // implementation of "which occurrences exist", and the two could
        // disagree about a record whose report changed after matching.
        // caseSensitive omitted for the same reason - MonitorRule has no such
        // column, so the matcher always used its default.
      },
      deps,
    );

    const resolved = await this.store.applyResult(candidate, result, new Date());

    if (result.outcome === 'OK') {
      summary.judged += 1;
    } else {
      summary.errored += 1;
      this.logger.warn(
        `semantic judge attempt failed, hit kept: match=${candidate.matchId} ` +
          `code=${result.error} decision=${result.decision.reason}`,
      );
    }
    if (result.decision.filtered) {
      summary.filtered += 1;
      this.logger.log(
        `semantic judge removed a hit from the effective result: match=${candidate.matchId} ` +
          `status=${result.verdict?.semanticStatus ?? 'n/a'} ` +
          `confidence=${result.verdict?.confidence ?? 'n/a'} decision=${result.decision.reason}`,
      );
    }
    return resolved;
  }

  /**
   * Where in the field to anchor this hit's context window.
   *
   * Prefers the offsets recorded with the match (exact, and what the engine
   * actually hit). Falls back to re-deriving them - which is the path for every
   * row written before #87 added the columns, and for a record whose report was
   * superseded after matching. Re-derivation uses the same strategy the matcher
   * uses and takes the FIRST occurrence, because that is the occurrence the
   * matcher's row represents (see the schema's matchStart doc).
   *
   * Returns null when neither route yields anything usable; the caller then
   * routes the hit through the task's EMPTY_CONTEXT path so the failure is
   * recorded and the hit is kept.
   */
  private resolveAnchor(candidate: SemanticJudgeCandidate): { start: number; end: number } | null {
    const { fieldText, matchStart, matchEnd } = candidate;
    if (fieldText === null) return null;

    const storedIsUsable =
      matchStart !== null &&
      matchEnd !== null &&
      matchStart >= 0 &&
      matchEnd > matchStart &&
      matchEnd <= fieldText.length;
    if (storedIsUsable) {
      return { start: matchStart, end: matchEnd };
    }

    const occurrences = deriveOccurrences(fieldText, candidate.keyword, candidate.matchMode, false);
    return occurrences.length > 0 ? occurrences[0] : null;
  }
}
