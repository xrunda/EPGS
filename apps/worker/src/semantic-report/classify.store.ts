import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AttentionLevel,
  AttentionLevelOrNone,
  AttentionSemanticSnapshot,
  ClassifyReportResult,
} from '@epgs/ai-semantic';
import { PrismaService } from '../prisma/prisma.service';
import { recomputeRecordLevels } from '../monitor/record-level';

/**
 * The database half of the report classifier (issue #88). Everything here is
 * Prisma-shaped; the CLASSIFICATION itself lives in @epgs/ai-semantic and never
 * touches a database, exactly as #87 splits the judge.
 *
 * THE QUEUE IS `ai_resolved_at IS NULL` - not a status column and not a queue
 * table, mirroring #87's `semantic_resolved_at`. The hand-written partial index
 * `uq_monitor_record_ai_queue ON (ai_claimed_at, id) WHERE ai_resolved_at IS
 * NULL` (see the migration) keeps the scan proportional to the BACKLOG rather
 * than to `monitor_record`, which only ever grows.
 *
 * CLAIMING IS OPTIMISTIC. Two workers may see the same pending record; the
 * claim UPDATE re-states the predicate the SELECT used, so exactly one gets
 * `count: 1` and the other moves on without spending a model call. A record
 * claimed by a worker that died becomes claimable again when the lease expires -
 * there is no advisory lock to leak.
 *
 * WHAT IS NEVER WRITTEN HERE: report text. The prompt, the model's raw response
 * and the evidence excerpts are never persisted - only content hashes and, on
 * the evidence rows, offsets into `monitor_record`'s already-access-controlled
 * report body. `reason` is the one free-text field, bounded and sanitized
 * upstream.
 */

/** One pending record, loaded with everything the task needs. */
export interface ClassifyRecordCandidate {
  monitorRecordId: string;
  reportVersion: number;
  examItem: string | null;
  reportContent: string | null;
  diagnosis: string | null;
}

/** What persisting one attempt did, so the caller's summary can report it honestly. */
export interface ClassifyApplyOutcome {
  /** True when THIS call resolved the record (false when it was already settled). */
  resolved: boolean;
  /** Records whose `monitor_record.current_level` moved as a result. 0 or 1. */
  levelsChanged: number;
}

@Injectable()
export class ClassifyReportStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The currently ENABLED attention semantics, in a deterministic order.
   *
   * Loaded ONCE per run, not per record: within a run every report is judged
   * against the same configuration, which is what makes `configHash` meaningful
   * - two records in one batch with equal hashes really were judged against the
   * same instructions.
   *
   * Ordered by id, the same order the task sorts in, so the two agree without
   * anyone having to remember.
   */
  async loadEnabledSemantics(): Promise<AttentionSemanticSnapshot[]> {
    const rows = await this.prisma.attentionSemantic.findMany({
      where: { isEnabled: true },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        version: true,
        attentionLevel: true,
        name: true,
        description: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      attentionLevel: row.attentionLevel,
      name: row.name,
      description: row.description,
    }));
  }

  /**
   * Claim up to `limit` pending records, oldest first.
   *
   * Oldest-first so a backlog that predates the classifier being switched on is
   * worked through before newly synced reports, rather than leaving a permanent
   * unclassified tail behind a steady stream of new ones. Ordered by `examTime`
   * then `id` - the same "oldest report first" sense an operator means, and a
   * total order so two batches never overlap.
   *
   * A record is skipped, not retried forever, once `aiAttempts` reaches
   * `maxAttempts`; the service drains those terminally (see resolveExhausted).
   */
  async claimBatch(params: {
    limit: number;
    maxAttempts: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClassifyRecordCandidate[]> {
    const { limit, maxAttempts, leaseMs, now } = params;
    const leaseCutoff = new Date(now.getTime() - leaseMs);

    const rows = await this.prisma.monitorRecord.findMany({
      where: {
        aiResolvedAt: null,
        aiAttempts: { lt: maxAttempts },
        OR: [{ aiClaimedAt: null }, { aiClaimedAt: { lt: leaseCutoff } }],
      },
      orderBy: [{ examTime: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        reportVersion: true,
        examItem: true,
        reportContent: true,
        diagnosis: true,
      },
    });

    const claimed: ClassifyRecordCandidate[] = [];
    for (const row of rows) {
      // Re-states the SELECT's predicate so a concurrent claimant loses here
      // rather than at the model call.
      const result = await this.prisma.monitorRecord.updateMany({
        where: {
          id: row.id,
          aiResolvedAt: null,
          aiAttempts: { lt: maxAttempts },
          OR: [{ aiClaimedAt: null }, { aiClaimedAt: { lt: leaseCutoff } }],
        },
        data: { aiClaimedAt: now, aiAttempts: { increment: 1 } },
      });
      if (result.count !== 1) continue;

      claimed.push({
        monitorRecordId: row.id,
        reportVersion: row.reportVersion,
        examItem: row.examItem,
        reportContent: row.reportContent,
        diagnosis: row.diagnosis,
      });
    }
    return claimed;
  }

  /**
   * Persist one attempt: the audit row (with its matches and evidence), then the
   * denormalized result onto the record, in ONE transaction. Returns true when
   * THIS call was the one that resolved the record, which is the caller's signal
   * that the record's level may need recomputing.
   *
   * THE LEVEL WRITE RULE, and why ERROR and OK differ:
   *
   *   outcome OK  - a verdict we stand behind, including a verdict of "nothing
   *                 applies". It DEFINES `ai_attention_level` (writing NULL when
   *                 no semantic matched, so a re-classification that finds
   *                 nothing clears a previous finding).
   *   outcome ERROR - no verdict. `ai_attention_level` is LEFT ALONE. A
   *                 transient gateway failure must not erase a verified
   *                 classification of the same text, and must never change a
   *                 keyword-derived level in either direction.
   *
   * In the ordinary flow the column is NULL by the time the first attempt lands,
   * because the sync job clears it whenever the report's content changes - so
   * the ERROR rule is invisible unless someone re-runs a classification
   * deliberately. It is written down here because the requeue path makes it
   * reachable.
   *
   * The record UPDATE is guarded by `aiResolvedAt: null` for the same reason the
   * claim is: whoever resolves first wins, so a straggler's late verdict can
   * never overwrite a settled one. The audit row is written regardless - one row
   * per attempt is the provenance trail, so a duplicate attempt is evidence
   * worth keeping, not noise worth suppressing.
   */
  async applyResult(
    candidate: ClassifyRecordCandidate,
    result: ClassifyReportResult,
    now: Date,
  ): Promise<ClassifyApplyOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const auditRow = await tx.monitorReportAi.create({
        data: {
          monitorRecordId: candidate.monitorRecordId,
          reportVersion: candidate.reportVersion,
          task: result.task,
          taskVersion: clip(result.taskVersion, 50),
          outcome: result.outcome,
          attentionLevel: result.attentionLevel,
          modelAttentionLevel: toStoredModelLevel(result.modelAttentionLevel),
          semanticCount: result.semanticCount,
          matchCount: result.matches.length,
          error: result.error === null ? null : clip(result.error, 64),
          model: clip(result.model, 100),
          modelVersion: result.modelVersion === null ? null : clip(result.modelVersion, 100),
          inputHash: result.inputHash,
          reportHash: result.reportHash,
          configHash: result.configHash,
          latencyMs: result.latencyMs,
          createdAt: now,
        },
      });

      // ALL verified matches, never only the highest (issue #88 §8). A match
      // cannot exist without at least one verified excerpt - the task rejects
      // the whole attempt otherwise - so the nested create always has evidence.
      for (const match of result.matches) {
        await tx.monitorReportAiMatch.create({
          data: {
            reportAiId: auditRow.id,
            semanticId: match.semanticId,
            semanticVersion: match.semanticVersion,
            semanticName: clip(match.semanticName, 100),
            attentionLevel: match.attentionLevel,
            confidence: match.confidence,
            reason: clip(match.reason, 300),
            ordinal: match.ordinal,
            evidence: {
              create: match.evidence.map((evidence, index) => ({
                ordinal: index,
                field: evidence.field,
                evidenceHash: evidence.hash,
                evidenceStart: evidence.start,
                evidenceEnd: evidence.end,
              })),
            },
          },
        });
      }

      const updated = await tx.monitorRecord.updateMany({
        where: { id: candidate.monitorRecordId, aiResolvedAt: null },
        data:
          result.outcome === 'OK'
            ? {
                aiAttentionLevel: result.attentionLevel,
                // Only advanced when this attempt actually verified something.
                // An OK attempt that matched nothing is a real, recorded
                // "nothing here" - it must not look like a fresh finding.
                ...(result.matches.length > 0 ? { aiMatchedAt: now } : {}),
                aiResolvedAt: now,
              }
            : { aiResolvedAt: now },
      });

      if (updated.count !== 1) {
        // Someone else resolved this record first. The audit row above stays -
        // one row per attempt is the provenance trail - but nothing is
        // denormalized and no level is touched.
        return { resolved: false, levelsChanged: 0 };
      }

      // The record's level is recomputed inside the same transaction that
      // changed its AI inputs, so it never becomes visible with a level that
      // disagrees with its own rows. This is the shared entry point (issue #88).
      const levelsChanged = await recomputeRecordLevels(tx, [candidate.monitorRecordId]);
      return { resolved: true, levelsChanged };
    });
  }

  /**
   * Records that burned every allowed attempt and are still unresolved - the
   * terminal case. Resolved without an audit row, mirroring #87: no attempt
   * produced a result to record, and the previous attempts' audit rows already
   * say why each of them failed. The record stays keyword-only, which is the
   * fail-safe direction: no AI finding is ever invented from a failure.
   *
   * `classify:once --requeue` is the deliberate way back.
   */
  async resolveExhausted(now: Date, maxAttempts: number): Promise<number> {
    const result = await this.prisma.monitorRecord.updateMany({
      where: { aiResolvedAt: null, aiAttempts: { gte: maxAttempts } },
      data: { aiResolvedAt: now },
    });
    return result.count;
  }

  /** How many records are still pending, for the run summary and the health log. */
  async countPending(maxAttempts: number): Promise<number> {
    return this.prisma.monitorRecord.count({
      where: { aiResolvedAt: null, aiAttempts: { lt: maxAttempts } },
    });
  }

  /**
   * Return resolved records to the queue for a deliberate re-classification
   * (`classify:once --requeue`).
   *
   * The denormalized `ai_attention_level` is left in place on purpose: clearing
   * it here would drop the record's level for as long as the re-run takes, and
   * if the new attempt fails the ERROR rule above leaves whatever is there
   * anyway. `aiAttempts` resets so the re-run is not immediately excluded by the
   * attempt cap.
   */
  async requeue(where: Prisma.MonitorRecordWhereInput): Promise<number> {
    const result = await this.prisma.monitorRecord.updateMany({
      where: { ...where, aiResolvedAt: { not: null } },
      data: { aiResolvedAt: null, aiClaimedAt: null, aiAttempts: 0 },
    });
    return result.count;
  }
}

/**
 * Map the model's claimed level onto the audit column.
 *
 * `model_attention_level` is an AttentionLevel column (RED/YELLOW/GREEN) - the
 * same enum as `monitor_record.current_level`, where "no level" is a real,
 * meaningful value that "NONE" must not be confused with. So a model answering
 * NONE is stored as NULL rather than by widening an enum that means something
 * else everywhere else it is used.
 *
 * Nothing is lost by that: a NULL on its own would be ambiguous, but on an OK
 * row it can only mean "the model said NONE". The coherence check in
 * classify-report.ts rejects any attempt whose claimed level disagrees with the
 * level computed from the verified matches, and with zero verified matches that
 * computed level is null - so an OK row with matches carries a real level here,
 * and an OK row without them carries NULL. ERROR rows are told apart by
 * `outcome`, and "the model was never asked" by `semanticCount = 0`.
 */
function toStoredModelLevel(level: AttentionLevelOrNone | null): AttentionLevel | null {
  return level === null || level === 'NONE' ? null : level;
}

/**
 * Truncate to a column's width. Model and error strings come from outside this
 * repository, and a DB write failure over a cosmetic overflow would lose the
 * whole attempt's audit row including its verdict.
 *
 * `reason` is truncated rather than rejected here because the task already
 * bounds it; this is the storage-width backstop, applied to the same value.
 */
function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
