import { SemanticJudgeStore } from './semantic-judge.store';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The judge's database adapter (issue #87), with a fake Prisma client - the
 * same approach as worker-alert-link.store.spec.ts. What is worth asserting
 * here is not that Prisma works, but the three properties the audit trail
 * depends on:
 *
 *  1. A claim is EXCLUSIVE (the UPDATE re-states the SELECT's predicate), so
 *     two workers cannot both spend a model call on one hit.
 *  2. The verdict write is GUARDED by `semanticResolvedAt IS NULL`, so a
 *     straggler's late answer cannot overwrite a settled one.
 *  3. No report text, verdict `reason` aside, is ever written verbatim: the
 *     context and the evidence become hashes and offsets.
 */

const NOW = new Date('2026-09-25T10:00:00.000Z');

/** A MonitorMatch row as the store's SELECT would shape it. */
function matchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    monitorRecordId: 'rec1',
    keyword: '溃疡',
    matchedField: 'FINDINGS',
    matchStart: 3,
    matchEnd: 5,
    reportVersion: 1,
    rule: { matchMode: 'CONTAINS', semanticIntent: '只关注本次明确或疑似病变' },
    record: { reportContent: '胃窦见溃疡。', diagnosis: '胃溃疡' },
    ...overrides,
  };
}

function makePrisma(
  options: {
    rows?: ReturnType<typeof matchRow>[];
    /** What every monitorMatch.updateMany call reports as affected. */
    updateManyCount?: number;
    grouped?: { level: string }[];
    currentLevel?: string;
  } = {},
) {
  const tx = {
    monitorMatchSemantic: { create: jest.fn(async (_args: unknown) => ({ id: 'audit-1' })) },
    monitorMatch: {
      updateMany: jest.fn(async (_args: unknown) => ({ count: options.updateManyCount ?? 1 })),
    },
  };
  return {
    tx,
    monitorMatch: {
      findMany: jest.fn(async (_args: unknown) => options.rows ?? []),
      updateMany: jest.fn(async (_args: unknown) => ({ count: options.updateManyCount ?? 1 })),
    },
    monitorRecord: {
      findUnique: jest.fn(async (_args: unknown): Promise<{ currentLevel: string } | null> => ({
        currentLevel: options.currentLevel ?? 'RED',
      })),
      update: jest.fn(async (_args: unknown) => ({ id: 'rec1' })),
    },
    $transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    _grouped: options.grouped ?? [{ level: 'GREEN' }],
  };
}

/** The store calls prisma.monitorMatch.groupBy directly (not through $transaction). */
function withGroupBy(prisma: ReturnType<typeof makePrisma>) {
  return Object.assign(prisma, {
    monitorMatch: Object.assign(prisma.monitorMatch, {
      groupBy: jest.fn(async (_args: unknown) => prisma._grouped),
      count: jest.fn(async (_args: unknown) => 0),
    }),
  });
}

describe('SemanticJudgeStore.claimBatch', () => {
  it('selects only judgeable pending rows, oldest first, and claims them exclusively', async () => {
    const prisma = withGroupBy(makePrisma({ rows: [matchRow()] }));
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    await store.claimBatch({ limit: 5, maxAttempts: 3, leaseMs: 300_000, now: NOW });

    const select = prisma.monitorMatch.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(select.where).toMatchObject({
      semanticResolvedAt: null,
      semanticAttempts: { lt: 3 },
    });
    // Unclaimed OR lease-expired - a claim held by a worker that died must not
    // strand the row forever.
    expect(select.where.OR).toEqual([
      { semanticClaimedAt: null },
      { semanticClaimedAt: { lt: new Date(NOW.getTime() - 300_000) } },
    ]);
    // Oldest first so a pre-rollout backlog is judged before new traffic.
    expect(select.orderBy).toEqual([{ matchedAt: 'asc' }, { id: 'asc' }]);
    expect(select.take).toBe(5);
    // The rule is joined for its match mode + the intent text that was in force.
    expect(prisma.monitorMatch.findMany.mock.calls[0][0]).toMatchObject({
      select: { rule: { select: { matchMode: true, semanticIntent: true } } },
    });

    const claim = prisma.monitorMatch.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // The UPDATE re-states the SELECT's predicate - plus the row id - which is
    // what makes the claim exclusive rather than merely optimistic.
    expect(claim.where).toEqual({ ...select.where, id: 'm1' });
    expect(claim.data).toMatchObject({
      semanticClaimedAt: NOW,
      semanticAttempts: { increment: 1 },
    });
  });

  it('maps the record column for the hit field, and null for fields with no text source', async () => {
    const prisma = withGroupBy(
      makePrisma({
        rows: [
          matchRow({ id: 'm1', matchedField: 'FINDINGS' }),
          matchRow({ id: 'm2', matchedField: 'IMPRESSION', keyword: '胃溃疡' }),
          matchRow({ id: 'm3', matchedField: 'OTHER' }),
        ],
      }),
    );
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    const candidates = await store.claimBatch({
      limit: 5,
      maxAttempts: 3,
      leaseMs: 300_000,
      now: NOW,
    });

    expect(candidates.map((c) => c.fieldText)).toEqual(['胃窦见溃疡。', '胃溃疡', null]);
    expect(candidates[0]).toMatchObject({
      matchId: 'm1',
      monitorRecordId: 'rec1',
      keyword: '溃疡',
      matchMode: 'CONTAINS',
      matchStart: 3,
      matchEnd: 5,
    });
  });

  it('drops a row another worker claimed first', async () => {
    // The claim UPDATE matched nothing because the row was taken between the
    // SELECT and the UPDATE. Dropping it here is what prevents a duplicate
    // model call.
    const prisma = withGroupBy(makePrisma({ rows: [matchRow()], updateManyCount: 0 }));
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    expect(
      await store.claimBatch({ limit: 5, maxAttempts: 3, leaseMs: 300_000, now: NOW }),
    ).toEqual([]);
  });
});

describe('SemanticJudgeStore.applyResult', () => {
  const candidate = {
    matchId: 'm1',
    monitorRecordId: 'rec1',
    keyword: '溃疡',
    semanticIntent: 'intent',
    matchField: 'FINDINGS' as const,
    matchMode: 'CONTAINS' as const,
    matchStart: 3,
    matchEnd: 5,
    fieldText: '胃窦见溃疡。',
    reportVersion: 1,
  };

  const okResult = {
    outcome: 'OK' as const,
    task: 'VALIDATE_MATCH' as const,
    taskVersion: 'validate-match/1',
    model: 'test-model',
    modelVersion: 'test-model-v2',
    latencyMs: 42,
    error: null,
    verdict: {
      matched: false,
      semanticStatus: 'NEGATED' as const,
      confidence: 'HIGH' as const,
      reason: '句子否定该病变',
      evidence: '未见明显溃疡',
      intentExcludesHistory: false,
    },
    evidence: { hash: 'a'.repeat(64), start: 30, end: 36 },
    context: { text: '十二指肠球部未见明显溃疡。', start: 20, end: 34, isWholeField: false },
    inputHash: 'b'.repeat(64),
    contextHash: 'c'.repeat(64),
    decision: { filtered: true, reason: 'NEGATED_HIGH_FILTER' as const },
  };

  it('writes the audit row and the guarded verdict in one transaction', async () => {
    const prisma = withGroupBy(makePrisma());
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    const resolved = await store.applyResult(candidate, okResult, NOW);

    expect(resolved).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    const audit = prisma.tx.monitorMatchSemantic.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({
      matchId: 'm1',
      task: 'VALIDATE_MATCH',
      taskVersion: 'validate-match/1',
      outcome: 'OK',
      semanticStatus: 'NEGATED',
      matched: false,
      confidence: 'HIGH',
      intentExcludesHistory: false,
      evidenceHash: 'a'.repeat(64),
      evidenceStart: 30,
      evidenceEnd: 36,
      model: 'test-model',
      modelVersion: 'test-model-v2',
      inputHash: 'b'.repeat(64),
      contextHash: 'c'.repeat(64),
      contextStart: 20,
      contextEnd: 34,
      latencyMs: 42,
      error: null,
      filtered: true,
      decisionReason: 'NEGATED_HIGH_FILTER',
    });

    // The raw hit is never rewritten - only the additive columns - and the write
    // is guarded so a late straggler cannot overwrite a settled verdict.
    const verdictWrite = prisma.tx.monitorMatch.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(verdictWrite.where).toEqual({ id: 'm1', semanticResolvedAt: null });
    expect(verdictWrite.data).toEqual({
      semanticStatus: 'NEGATED',
      semanticConfidence: 'HIGH',
      semanticFiltered: true,
      semanticResolvedAt: NOW,
    });
    expect(verdictWrite.data).not.toHaveProperty('keyword');
    expect(verdictWrite.data).not.toHaveProperty('level');
    expect(verdictWrite.data).not.toHaveProperty('contextSnippet');
  });

  it('persists hashes and offsets, never the report or the context text', async () => {
    const prisma = withGroupBy(makePrisma());
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    await store.applyResult(candidate, okResult, NOW);

    // The strongest privacy property in this feature: nothing written may
    // contain the excerpt that was sent to the model.
    const written = JSON.stringify(prisma.tx.monitorMatchSemantic.create.mock.calls[0][0]);
    expect(written).not.toContain('十二指肠球部未见明显溃疡');
    expect(written).not.toContain('胃窦见溃疡');
    expect(written).not.toContain('未见明显溃疡');
  });

  it('records a failure as fail-open: no verdict, unfiltered, error code only', async () => {
    const prisma = withGroupBy(makePrisma());
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    await store.applyResult(
      candidate,
      {
        ...okResult,
        outcome: 'ERROR',
        error: 'TIMEOUT',
        verdict: null,
        evidence: null,
        modelVersion: null,
        latencyMs: null,
        decision: { filtered: false, reason: 'TIMEOUT_KEEP' },
      },
      NOW,
    );

    const audit = prisma.tx.monitorMatchSemantic.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({
      outcome: 'ERROR',
      error: 'TIMEOUT',
      semanticStatus: null,
      matched: null,
      confidence: null,
      evidenceHash: null,
      evidenceStart: null,
      filtered: false,
      decisionReason: 'TIMEOUT_KEEP',
    });
    expect(
      (prisma.tx.monitorMatch.updateMany.mock.calls[0][0] as { data: Record<string, unknown> })
        .data,
    ).toMatchObject({ semanticFiltered: false, semanticResolvedAt: NOW });
  });

  it('reports false when another worker settled the row first', async () => {
    const prisma = withGroupBy(makePrisma({ updateManyCount: 0 }));
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    expect(await store.applyResult(candidate, okResult, NOW)).toBe(false);
    // The audit row is written anyway: one row per attempt IS the provenance
    // trail, and a losing attempt is still an attempt worth recording.
    expect(prisma.tx.monitorMatchSemantic.create).toHaveBeenCalledTimes(1);
  });
});

describe('SemanticJudgeStore.resolveSkipped', () => {
  it('drains the row without an audit row and without touching the verdict', async () => {
    const prisma = withGroupBy(makePrisma());
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    expect(await store.resolveSkipped('m1', NOW)).toBe(true);

    expect(prisma.monitorMatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1', semanticResolvedAt: null },
      data: { semanticResolvedAt: NOW },
    });
    // No model, no judgement, and critically no `semanticFiltered: true` - a
    // skipped hit stands.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('SemanticJudgeStore.recomputeLevels', () => {
  it('takes the highest level among UNFILTERED hits', async () => {
    const prisma = withGroupBy(
      makePrisma({ grouped: [{ level: 'YELLOW' }, { level: 'GREEN' }], currentLevel: 'RED' }),
    );
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    expect(await store.recomputeLevels(['rec1'])).toBe(1);

    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith({
      by: ['level'],
      where: { monitorRecordId: 'rec1', semanticFiltered: false },
    });
    expect(prisma.monitorRecord.update).toHaveBeenCalledWith({
      where: { id: 'rec1' },
      data: { currentLevel: 'YELLOW' },
    });
  });

  it('falls back to UNCLASSIFIED when every hit was filtered', async () => {
    // Filtering the last hit of a record must take the record down with it -
    // otherwise a filtered hit would keep driving the workbench.
    const prisma = withGroupBy(makePrisma({ grouped: [], currentLevel: 'RED' }));
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    await store.recomputeLevels(['rec1']);

    expect(prisma.monitorRecord.update).toHaveBeenCalledWith({
      where: { id: 'rec1' },
      data: { currentLevel: 'UNCLASSIFIED' },
    });
  });

  it('writes nothing when the level already agrees', async () => {
    const prisma = withGroupBy(makePrisma({ grouped: [{ level: 'RED' }], currentLevel: 'RED' }));
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    expect(await store.recomputeLevels(['rec1'])).toBe(0);
    expect(prisma.monitorRecord.update).not.toHaveBeenCalled();
  });

  it('visits each record once even when a batch names it several times', async () => {
    const prisma = withGroupBy(makePrisma({ grouped: [{ level: 'RED' }], currentLevel: 'RED' }));
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    await store.recomputeLevels(['rec1', 'rec1', 'rec1']);

    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a record that has since been deleted', async () => {
    const prisma = withGroupBy(makePrisma({ grouped: [{ level: 'RED' }] }));
    prisma.monitorRecord.findUnique.mockResolvedValueOnce(null);
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    expect(await store.recomputeLevels(['gone'])).toBe(0);
    expect(prisma.monitorRecord.update).not.toHaveBeenCalled();
  });
});

describe('SemanticJudgeStore queue maintenance', () => {
  it('resolves rows that burned every attempt, without a synthetic audit row', async () => {
    const prisma = withGroupBy(makePrisma());
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    await store.resolveExhausted(NOW, 3);

    expect(prisma.monitorMatch.updateMany).toHaveBeenCalledWith({
      where: { semanticResolvedAt: null, semanticAttempts: { gte: 3 } },
      data: { semanticResolvedAt: NOW },
    });
  });

  it('counts only rows that still have attempts left', async () => {
    const prisma = withGroupBy(makePrisma());
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    await store.countPending(3);

    expect(prisma.monitorMatch.count).toHaveBeenCalledWith({
      where: { semanticResolvedAt: null, semanticAttempts: { lt: 3 } },
    });
  });

  it('requeues only resolved rows, resetting the claim and the attempt count', async () => {
    const prisma = withGroupBy(makePrisma({ updateManyCount: 2 }));
    const store = new SemanticJudgeStore(prisma as unknown as PrismaService);

    const count = await store.requeue({ rule: { ruleGroupId: 'g1' } });

    expect(count).toBe(2);
    expect(prisma.monitorMatch.updateMany).toHaveBeenCalledWith({
      where: { rule: { ruleGroupId: 'g1' }, semanticResolvedAt: { not: null } },
      data: { semanticResolvedAt: null, semanticClaimedAt: null, semanticAttempts: 0 },
    });
  });
});
