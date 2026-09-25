import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LEVEL_PRIORITY, MatchField, MatchMode, MonitorLevel } from '@epgs/matching-engine';
import type { ValidateMatchResult } from '@epgs/ai-semantic';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The database half of the semantic judge (issue #87). Everything here is
 * Prisma-shaped; the JUDGEMENT itself lives in @epgs/ai-semantic and never
 * touches a database. Splitting it this way keeps the task layer unit-testable
 * without Postgres and keeps every SQL concern in one reviewable file.
 *
 * THE QUEUE IS `semantic_resolved_at IS NULL`. Not a status column, not a
 * separate queue table: a match row is pending until something writes a
 * terminal timestamp on it, and the partial index
 * `uq_monitor_match_semantic_queue ON (semantic_claimed_at, id) WHERE
 * semantic_resolved_at IS NULL` (hand-written - see the migration) keeps that
 * scan proportional to the BACKLOG rather than to the whole match table, which
 * only ever grows.
 *
 * CLAIMING IS OPTIMISTIC, NOT LOCKED. Two workers may both see the same
 * pending row; the claim UPDATE re-states the same predicate the SELECT used
 * (unresolved + unclaimed-or-lease-expired), so exactly one of them gets
 * `count: 1` and the other moves on without spending a model call. This is the
 * same belt-and-suspenders stance as the sync job's `skipDuplicates`: the
 * deployment is single-worker today, but nothing here breaks if a second one
 * is added, and there is no advisory lock to leak if a process is killed
 * mid-judgement - a row claimed by a worker that died simply becomes claimable
 * again once the lease expires.
 *
 * WHAT IS NEVER WRITTEN HERE: report text. The context sent to the model and
 * the evidence it quoted are stored as hashes + offsets into
 * `monitor_record`'s already-access-controlled report body, never verbatim.
 * `reason` is the one free-text field, and it is bounded and sanitized
 * upstream (see @epgs/ai-semantic's MAX_REASON_LENGTH). The `error` column
 * holds a machine code only - never a raw response, which can echo the report.
 */

/**
 * One pending hit, loaded with everything the task needs in a single query.
 * `fieldText` is resolved from the record here rather than in the service so
 * the "which column backs which match field" question has one answer.
 */
export interface SemanticJudgeCandidate {
  matchId: string;
  monitorRecordId: string;
  keyword: string;
  /** The rule version that matched, i.e. the intent text in force at match time. */
  semanticIntent: string | null;
  matchField: MatchField;
  matchMode: MatchMode;
  /** Anchor occurrence offsets, NULL for rows written before #87. */
  matchStart: number | null;
  matchEnd: number | null;
  /** The field's full original text, or null when the field has no text source. */
  fieldText: string | null;
  reportVersion: number;
}

/**
 * Which report column backs each match field.
 *
 * Only FINDINGS and IMPRESSION have a text source in this repo - the
 * matching engine says as much (MatchableTextField in its types.ts), and
 * `matched.field` is always the CONCRETE field that hit, never a broad
 * "all text" pseudo-field. The other three values are accepted by the schema
 * but can never carry a hit, so returning null for them is a completeness
 * guard rather than an expected path: a candidate with no text source is
 * resolved as skipped, never judged, and never filtered.
 */
function fieldTextFor(row: {
  matchedField: string;
  record: { reportContent: string | null; diagnosis: string | null };
}): string | null {
  switch (row.matchedField) {
    case 'FINDINGS':
      return row.record.reportContent;
    case 'IMPRESSION':
      return row.record.diagnosis;
    default:
      return null;
  }
}

@Injectable()
export class SemanticJudgeStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim up to `limit` pending hits, oldest first.
   *
   * Oldest-first is deliberate: the backlog that existed before the judge was
   * switched on gets judged before newly synced reports, so a rollout does not
   * leave a permanent un-judged tail behind a steady stream of new matches.
   *
   * A row is skipped, not retried forever, once `semanticAttempts` reaches
   * `maxAttempts` - a poison row (a rule whose prompt makes the model emit
   * garbage every time) must not consume a model call per tick indefinitely.
   * The service resolves such rows terminally, fail-open.
   */
  async claimBatch(params: {
    limit: number;
    maxAttempts: number;
    leaseMs: number;
    now: Date;
  }): Promise<SemanticJudgeCandidate[]> {
    const { limit, maxAttempts, leaseMs, now } = params;
    const leaseCutoff = new Date(now.getTime() - leaseMs);

    const rows = await this.prisma.monitorMatch.findMany({
      where: {
        semanticResolvedAt: null,
        semanticAttempts: { lt: maxAttempts },
        OR: [{ semanticClaimedAt: null }, { semanticClaimedAt: { lt: leaseCutoff } }],
      },
      orderBy: [{ matchedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        monitorRecordId: true,
        keyword: true,
        matchedField: true,
        matchStart: true,
        matchEnd: true,
        reportVersion: true,
        // The FROZEN rule version, not the rule group's current one: this is
        // the intent text that was in force when the keyword matched, and it is
        // what the audit row's inputHash commits to. Reading the newest version
        // instead would make every historical judgement's hash unverifiable the
        // moment someone edited the rule - see the schema's semanticIntent doc.
        rule: { select: { matchMode: true, semanticIntent: true } },
        record: { select: { reportContent: true, diagnosis: true } },
      },
    });

    const claimed: SemanticJudgeCandidate[] = [];
    for (const row of rows) {
      // Re-states the SELECT's predicate so a concurrent claimant loses here
      // rather than at the model call.
      const result = await this.prisma.monitorMatch.updateMany({
        where: {
          id: row.id,
          semanticResolvedAt: null,
          semanticAttempts: { lt: maxAttempts },
          OR: [{ semanticClaimedAt: null }, { semanticClaimedAt: { lt: leaseCutoff } }],
        },
        data: { semanticClaimedAt: now, semanticAttempts: { increment: 1 } },
      });
      if (result.count !== 1) continue;

      claimed.push({
        matchId: row.id,
        monitorRecordId: row.monitorRecordId,
        keyword: row.keyword,
        semanticIntent: row.rule.semanticIntent,
        matchField: row.matchedField as MatchField,
        matchMode: row.rule.matchMode as MatchMode,
        matchStart: row.matchStart,
        matchEnd: row.matchEnd,
        fieldText: fieldTextFor(row),
        reportVersion: row.reportVersion,
      });
    }
    return claimed;
  }

  /**
   * Take a hit out of the queue without judging it and without an audit row.
   *
   * Used for the two "there is nothing to judge" cases: the rule has no
   * semantic intent configured, or the hit's field has no text source. Both are
   * reconstructable from the match row itself (rule.semanticIntent IS NULL /
   * matched_field has no backing column), so an audit row would record nothing
   * an auditor could not already read - and per the design decision, a rule
   * nobody configured must behave exactly as it did before #87, which includes
   * leaving no trace in the AI audit table.
   *
   * TERMINAL AND NOT RETRIED. Adding an intent to a rule later creates a NEW
   * MonitorRule version (see the schema's semanticIntent doc), so these rows
   * keep pointing at the version that had no intent. That matches this
   * repository's existing and documented rule-edit behaviour - a rule change
   * affects new data, not the historical backlog - with `semantic:once
   * --rejudge` as the deliberate, manual exception.
   */
  async resolveSkipped(matchId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.monitorMatch.updateMany({
      where: { id: matchId, semanticResolvedAt: null },
      data: { semanticResolvedAt: now },
    });
    return result.count === 1;
  }

  /**
   * Persist one attempt: the audit row, then the verdict denormalized onto the
   * match, in ONE transaction.
   *
   * The verdict write is guarded by `semanticResolvedAt: null` for the same
   * reason the claim is: whoever resolves first wins, and a straggler's late
   * verdict can never overwrite a settled one. The audit row is written
   * regardless - one row per attempt is the provenance trail, so a duplicate
   * attempt is evidence worth keeping, not noise worth suppressing.
   *
   * Returns true when THIS call was the one that resolved the row, which is the
   * caller's signal that the record's level may need recomputing.
   */
  async applyResult(
    candidate: SemanticJudgeCandidate,
    result: ValidateMatchResult,
    now: Date,
  ): Promise<boolean> {
    const verdict = result.verdict;

    return this.prisma.$transaction(async (tx) => {
      await tx.monitorMatchSemantic.create({
        data: {
          matchId: candidate.matchId,
          task: result.task,
          taskVersion: result.taskVersion,
          outcome: result.outcome,
          semanticStatus: verdict?.semanticStatus ?? null,
          matched: verdict?.matched ?? null,
          confidence: verdict?.confidence ?? null,
          reason: verdict?.reason ?? null,
          intentExcludesHistory: verdict?.intentExcludesHistory ?? null,
          evidenceHash: result.evidence?.hash ?? null,
          evidenceStart: result.evidence?.start ?? null,
          evidenceEnd: result.evidence?.end ?? null,
          model: clip(result.model, 100),
          modelVersion: result.modelVersion === null ? null : clip(result.modelVersion, 100),
          inputHash: result.inputHash,
          contextHash: result.contextHash,
          contextStart: result.context.start,
          contextEnd: result.context.end,
          latencyMs: result.latencyMs,
          error: result.error === null ? null : clip(result.error, 255),
          filtered: result.decision.filtered,
          decisionReason: result.decision.reason,
          createdAt: now,
        },
      });

      const updated = await tx.monitorMatch.updateMany({
        where: { id: candidate.matchId, semanticResolvedAt: null },
        data: {
          semanticStatus: verdict?.semanticStatus ?? null,
          semanticConfidence: verdict?.confidence ?? null,
          semanticFiltered: result.decision.filtered,
          semanticResolvedAt: now,
        },
      });
      return updated.count === 1;
    });
  }

  /**
   * Rows that burned every allowed attempt and are still unresolved - the
   * terminal fail-open case. Resolved here rather than in `applyResult` because
   * no attempt produced a result to record; the previous attempts' audit rows
   * already say why each of them failed (they are the last thing the row's
   * trail shows), so a synthetic extra row would only add a non-attempt.
   */
  async resolveExhausted(now: Date, maxAttempts: number): Promise<number> {
    const result = await this.prisma.monitorMatch.updateMany({
      where: { semanticResolvedAt: null, semanticAttempts: { gte: maxAttempts } },
      data: { semanticResolvedAt: now },
    });
    return result.count;
  }

  /**
   * How many hits are still pending, for the run summary and the health log.
   * Counts only judgeable rows (attempts remaining) - a row at the attempt cap
   * is drained by resolveExhausted, not waiting on anything.
   */
  async countPending(maxAttempts: number): Promise<number> {
    return this.prisma.monitorMatch.count({
      where: { semanticResolvedAt: null, semanticAttempts: { lt: maxAttempts } },
    });
  }

  /**
   * Recompute `monitor_record.current_level` from the record's EFFECTIVE hits -
   * the ones the decision matrix did not filter.
   *
   * This is the one place #87 changes what the rest of the system displays:
   * `current_level` is the single denormalized driver of the workbench list,
   * the push rules' summaries, and every level-based count, so a filtered hit
   * must not keep contributing to it. The rule is unchanged from issue #5 -
   * highest level wins, RED > YELLOW > GREEN > UNCLASSIFIED - applied over the
   * surviving subset; a record whose every hit was filtered falls back to
   * UNCLASSIFIED, which is the honest answer (it has no effective hits) and is
   * why this recomputes downward as well as upward.
   *
   * NOT touched: firstMatchedAt / lastMatchedAt. Those record when the keyword
   * engine matched, which is a true statement about the raw hits and stays true
   * after a filter; they drive no level and no notification, only the
   * workbench's sort options. Rewriting them would be a behaviour change #87
   * did not ask for, and "when did this record first match a keyword" is not a
   * question the AI verdict should be allowed to answer differently.
   *
   * Bounded by `recordIds`, so a tick costs one GROUP BY per affected record
   * rather than a table scan. Returns the number of records whose level moved.
   */
  async recomputeLevels(recordIds: readonly string[]): Promise<number> {
    let changed = 0;
    for (const recordId of new Set(recordIds)) {
      const grouped = await this.prisma.monitorMatch.groupBy({
        by: ['level'],
        where: { monitorRecordId: recordId, semanticFiltered: false },
      });
      const survivors = grouped.map((row) => row.level as MonitorLevel);
      const level: MonitorLevel =
        LEVEL_PRIORITY.find((candidate) => survivors.includes(candidate)) ?? 'UNCLASSIFIED';

      const record = await this.prisma.monitorRecord.findUnique({
        where: { id: recordId },
        select: { currentLevel: true },
      });
      if (record === null || record.currentLevel === level) continue;

      await this.prisma.monitorRecord.update({
        where: { id: recordId },
        data: { currentLevel: level },
      });
      changed += 1;
    }
    return changed;
  }

  /**
   * Return resolved rows to the queue for a deliberate re-judgement (the
   * `semantic:once --rejudge` escape hatch). The denormalized verdict is left
   * in place on purpose: clearing `semanticFiltered` here would make a filtered
   * hit visible again for as long as the re-run takes, and if the new attempt
   * fails the fail-open path sets it back to false itself. `semanticAttempts`
   * is reset so the re-run is not immediately excluded by the attempt cap.
   */
  async requeue(where: Prisma.MonitorMatchWhereInput): Promise<number> {
    const result = await this.prisma.monitorMatch.updateMany({
      where: { ...where, semanticResolvedAt: { not: null } },
      data: { semanticResolvedAt: null, semanticClaimedAt: null, semanticAttempts: 0 },
    });
    return result.count;
  }
}

/**
 * Truncate to a column's width. A model version string from an unknown gateway
 * is the one field here whose length this repository does not control, and a
 * DB write failure over a cosmetic overflow would lose the whole attempt's
 * audit row including its verdict.
 */
function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
