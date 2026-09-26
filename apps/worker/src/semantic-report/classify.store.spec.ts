import { ClassifyReportStore } from './classify.store';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The classifier's database adapter (issue #88), with a fake Prisma client.
 *
 * What is worth asserting is not that Prisma works, but the properties the
 * feature's safety story rests on:
 *
 *  1. A claim is EXCLUSIVE, so two workers cannot both spend a model call on
 *     one report.
 *  2. The record write is GUARDED by `aiResolvedAt IS NULL`, so a straggler
 *     cannot overwrite a settled verdict.
 *  3. OK and ERROR write different things: an OK attempt (including "nothing
 *     applies") DEFINES `ai_attention_level`; an ERROR attempt leaves it alone,
 *     so a transient gateway failure cannot erase a verified classification.
 *  4. No report text and no evidence excerpt is ever written verbatim - only
 *     hashes and offsets.
 *  5. The level recompute happens INSIDE the same transaction as the write that
 *     changed its inputs.
 */

const NOW = new Date('2026-09-25T10:00:00.000Z');

const REPORT_TEXT = '胃体见巨大不规则隆起，表面糜烂，质脆，触之易出血。';
const DIAGNOSIS_TEXT = '胃体占位性病变，性质待定。';

/** A pending MonitorRecord as claimBatch's SELECT shapes it. */
function recordRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec1',
    reportVersion: 1,
    examItem: '电子胃镜检查',
    reportContent: REPORT_TEXT,
    diagnosis: DIAGNOSIS_TEXT,
    ...overrides,
  };
}

function makePrisma(
  options: {
    rows?: ReturnType<typeof recordRow>[];
    semantics?: {
      id: string;
      version: number;
      attentionLevel: string;
      name: string;
      description: string;
    }[];
    /** What every monitorRecord.updateMany reports as affected. */
    updateManyCount?: number;
    /** What the shared level recompute's GROUP BY reports. */
    grouped?: { monitorRecordId: string; level: string }[];
    currentLevel?: string;
    aiAttentionLevel?: string | null;
  } = {},
) {
  const tx = {
    monitorReportAi: { create: jest.fn(async (_args: unknown) => ({ id: 'ai-1' })) },
    monitorReportAiMatch: { create: jest.fn(async (_args: unknown) => ({ id: 'aim-1' })) },
    monitorRecord: {
      findMany: jest.fn(async (_args: unknown) => [
        {
          id: 'rec1',
          currentLevel: options.currentLevel ?? 'UNCLASSIFIED',
          aiAttentionLevel: options.aiAttentionLevel ?? null,
        },
      ]),
      updateMany: jest.fn(async (_args: unknown) => ({ count: 1 })),
    },
    monitorMatch: { groupBy: jest.fn(async (_args: unknown) => options.grouped ?? []) },
  };
  return {
    tx,
    attentionSemantic: { findMany: jest.fn(async (_args: unknown) => options.semantics ?? []) },
    monitorRecord: {
      findMany: jest.fn(async (_args: unknown) => options.rows ?? []),
      updateMany: jest.fn(async (_args: unknown) => ({ count: options.updateManyCount ?? 1 })),
      count: jest.fn(async (_args: unknown) => 7),
    },
    $transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };
}

function makeStore(prisma: ReturnType<typeof makePrisma>) {
  return new ClassifyReportStore(prisma as unknown as PrismaService);
}

const candidate = {
  monitorRecordId: 'rec1',
  reportVersion: 1,
  examItem: '电子胃镜检查',
  reportContent: REPORT_TEXT,
  diagnosis: DIAGNOSIS_TEXT,
};

/** An OK result with one verified RED match, as @epgs/ai-semantic returns it. */
function okResult(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'OK' as const,
    task: 'CLASSIFY_REPORT' as const,
    taskVersion: 'classify-report/1',
    model: 'test-model',
    modelVersion: 'test-model-v2',
    latencyMs: 321,
    error: null,
    attentionLevel: 'RED' as const,
    modelAttentionLevel: 'RED' as const,
    semanticCount: 3,
    matches: [
      {
        semanticId: 'sem-1',
        semanticVersion: 2,
        semanticName: '明确或高度疑似恶性病变',
        attentionLevel: 'RED' as const,
        confidence: 'HIGH' as const,
        reason: '报告描述巨大不规则隆起并触及出血，符合该语义',
        ordinal: 0,
        evidence: [{ field: 'FINDINGS' as const, hash: 'a'.repeat(64), start: 0, end: 12 }],
      },
    ],
    inputHash: 'b'.repeat(64),
    reportHash: 'c'.repeat(64),
    configHash: 'd'.repeat(64),
    ...overrides,
  };
}

describe('ClassifyReportStore.loadEnabledSemantics', () => {
  it('reads only enabled entries, in a deterministic order, and projects to a snapshot', async () => {
    const prisma = makePrisma({
      semantics: [
        { id: 'sem-1', version: 2, attentionLevel: 'RED', name: '恶性病变', description: '描述一' },
      ],
    });

    const semantics = await makeStore(prisma).loadEnabledSemantics();

    expect(prisma.attentionSemantic.findMany).toHaveBeenCalledWith({
      where: { isEnabled: true },
      orderBy: { id: 'asc' },
      select: { id: true, version: true, attentionLevel: true, name: true, description: true },
    });
    // The snapshot carries the four fields the prompt shows and the hash covers
    // - and nothing else, so no internal column can leak into a prompt.
    expect(semantics).toEqual([
      { id: 'sem-1', version: 2, attentionLevel: 'RED', name: '恶性病变', description: '描述一' },
    ]);
  });
});

describe('ClassifyReportStore.claimBatch', () => {
  it('selects only unexhausted pending rows, oldest report first, and claims them exclusively', async () => {
    const prisma = makePrisma({ rows: [recordRow()] });

    const claimed = await makeStore(prisma).claimBatch({
      limit: 5,
      maxAttempts: 3,
      leaseMs: 600_000,
      now: NOW,
    });

    const select = prisma.monitorRecord.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(select.where).toMatchObject({
      aiResolvedAt: null,
      aiAttempts: { lt: 3 },
    });
    // Unclaimed OR lease-expired - a claim held by a worker that died must not
    // strand the record forever.
    expect(select.where.OR).toEqual([
      { aiClaimedAt: null },
      { aiClaimedAt: { lt: new Date(NOW.getTime() - 600_000) } },
    ]);
    // Oldest report first, so a pre-rollout backlog is worked through before
    // new traffic; `id` as the tie-break makes it a total order, so two
    // batches can never overlap.
    expect(select.orderBy).toEqual([{ examTime: 'asc' }, { id: 'asc' }]);
    expect(select.take).toBe(5);

    const claim = prisma.monitorRecord.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // The UPDATE re-states the SELECT's predicate plus the row id - which is
    // what makes the claim exclusive rather than merely optimistic.
    expect(claim.where).toEqual({ ...select.where, id: 'rec1' });
    expect(claim.data).toEqual({ aiClaimedAt: NOW, aiAttempts: { increment: 1 } });
    expect(claimed).toEqual([candidate]);
  });

  it('drops a row another worker claimed first', async () => {
    // The claim UPDATE matched nothing because the row was taken between the
    // SELECT and the UPDATE. Dropping it here is what prevents a duplicate
    // model call on a whole report.
    const prisma = makePrisma({ rows: [recordRow()], updateManyCount: 0 });

    expect(
      await makeStore(prisma).claimBatch({ limit: 5, maxAttempts: 3, leaseMs: 600_000, now: NOW }),
    ).toEqual([]);
  });
});

describe('ClassifyReportStore.applyResult', () => {
  it('writes the audit row, its matches and its evidence, then the record - in one transaction', async () => {
    const prisma = makePrisma({ grouped: [{ monitorRecordId: 'rec1', level: 'RED' }] });

    const outcome = await makeStore(prisma).applyResult(candidate, okResult(), NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ resolved: true, levelsChanged: 1 });

    const audit = prisma.tx.monitorReportAi.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({
      monitorRecordId: 'rec1',
      reportVersion: 1,
      task: 'CLASSIFY_REPORT',
      taskVersion: 'classify-report/1',
      outcome: 'OK',
      attentionLevel: 'RED',
      modelAttentionLevel: 'RED',
      semanticCount: 3,
      matchCount: 1,
      error: null,
      model: 'test-model',
      modelVersion: 'test-model-v2',
      inputHash: 'b'.repeat(64),
      reportHash: 'c'.repeat(64),
      configHash: 'd'.repeat(64),
      latencyMs: 321,
    });

    const match = prisma.tx.monitorReportAiMatch.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(match.data).toMatchObject({
      reportAiId: 'ai-1',
      semanticId: 'sem-1',
      semanticVersion: 2,
      semanticName: '明确或高度疑似恶性病变',
      attentionLevel: 'RED',
      confidence: 'HIGH',
      ordinal: 0,
      evidence: {
        create: [
          {
            ordinal: 0,
            field: 'FINDINGS',
            evidenceHash: 'a'.repeat(64),
            evidenceStart: 0,
            evidenceEnd: 12,
          },
        ],
      },
    });
  });

  it('defines the record level on OK and advances aiMatchedAt only when something matched', async () => {
    const prisma = makePrisma();

    await makeStore(prisma).applyResult(candidate, okResult(), NOW);

    const write = prisma.tx.monitorRecord.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Guarded, so a straggler's late verdict cannot overwrite a settled one.
    expect(write.where).toEqual({ id: 'rec1', aiResolvedAt: null });
    expect(write.data).toEqual({
      aiAttentionLevel: 'RED',
      aiMatchedAt: NOW,
      aiResolvedAt: NOW,
    });
  });

  it('records a verified NONE as a verdict, clearing any previous AI level', async () => {
    const prisma = makePrisma();

    await makeStore(prisma).applyResult(
      candidate,
      okResult({ attentionLevel: null, modelAttentionLevel: 'NONE', matches: [] }),
      NOW,
    );

    const write = prisma.tx.monitorRecord.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // "Nothing here" is a real, recorded answer: the level is DEFINED as null so
    // a re-classification cannot leave a stale finding behind...
    expect(write.data).toEqual({ aiAttentionLevel: null, aiResolvedAt: NOW });
    // ...while aiMatchedAt stays put, because an empty answer is not a finding.
    expect(write.data).not.toHaveProperty('aiMatchedAt');
    // And no match rows are invented for it.
    expect(prisma.tx.monitorReportAiMatch.create).not.toHaveBeenCalled();
  });

  it('stores a model that answered NONE as a NULL claimed level', async () => {
    const prisma = makePrisma();

    await makeStore(prisma).applyResult(
      candidate,
      okResult({ attentionLevel: null, modelAttentionLevel: 'NONE', matches: [] }),
      NOW,
    );

    // `model_attention_level` is an AttentionLevel column - the same enum as
    // current_level, where "no level" means something else. A NULL here on an OK
    // row can only mean the model said NONE, because the coherence check rejects
    // any claimed level that disagrees with the verified matches.
    expect(
      (prisma.tx.monitorReportAi.create.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({ outcome: 'OK', attentionLevel: null, modelAttentionLevel: null });
  });

  it('leaves the level ALONE on a failed attempt', async () => {
    const prisma = makePrisma();

    await makeStore(prisma).applyResult(
      candidate,
      okResult({
        outcome: 'ERROR',
        error: 'TIMEOUT',
        attentionLevel: null,
        modelAttentionLevel: null,
        matches: [],
      }),
      NOW,
    );

    const write = prisma.tx.monitorRecord.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // A transient gateway failure must not erase a verified classification of
    // the same text, and must never move a keyword-derived level in either
    // direction - so it resolves the attempt and touches nothing else.
    expect(write.data).toEqual({ aiResolvedAt: NOW });
    expect(write.data).not.toHaveProperty('aiAttentionLevel');
    expect(prisma.tx.monitorReportAiMatch.create).not.toHaveBeenCalled();
  });

  it('persists hashes and offsets, never the report text or the evidence excerpt', async () => {
    const prisma = makePrisma();

    await makeStore(prisma).applyResult(candidate, okResult(), NOW);

    // The strongest privacy property in this feature: nothing written may
    // contain the text that was sent, or the excerpt the model quoted back.
    const written = JSON.stringify([
      prisma.tx.monitorReportAi.create.mock.calls[0][0],
      prisma.tx.monitorReportAiMatch.create.mock.calls[0][0],
    ]);
    expect(written).not.toContain(REPORT_TEXT);
    expect(written).not.toContain(DIAGNOSIS_TEXT);
    expect(written).not.toContain(REPORT_TEXT.slice(0, 12));
  });

  it('recomputes the level inside the SAME transaction that changed its inputs', async () => {
    const prisma = makePrisma({ grouped: [{ monitorRecordId: 'rec1', level: 'YELLOW' }] });

    await makeStore(prisma).applyResult(
      candidate,
      okResult({ attentionLevel: 'YELLOW', modelAttentionLevel: 'YELLOW' }),
      NOW,
    );

    // Read through the transaction client, not the pool: a record must never be
    // visible with a level that disagrees with the AI result just written.
    expect(prisma.tx.monitorMatch.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.tx.monitorRecord.updateMany).toHaveBeenCalledTimes(2);
    const levelWrite = prisma.tx.monitorRecord.updateMany.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(levelWrite.data).toEqual({ currentLevel: 'YELLOW' });
  });

  it('reports unresolved - and touches no level - when another worker settled the record first', async () => {
    const prisma = makePrisma();
    prisma.tx.monitorRecord.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await makeStore(prisma).applyResult(candidate, okResult(), NOW);

    expect(outcome).toEqual({ resolved: false, levelsChanged: 0 });
    // The audit row is written anyway: one row per attempt IS the provenance
    // trail, and a losing attempt is still an attempt worth recording.
    expect(prisma.tx.monitorReportAi.create).toHaveBeenCalledTimes(1);
    expect(prisma.tx.monitorMatch.groupBy).not.toHaveBeenCalled();
  });

  it('truncates an over-long model name rather than losing the whole audit row', async () => {
    const prisma = makePrisma();

    await makeStore(prisma).applyResult(
      candidate,
      okResult({ model: 'm'.repeat(500), error: null }),
      NOW,
    );

    const audit = prisma.tx.monitorReportAi.create.mock.calls[0][0] as {
      data: { model: string };
    };
    // The column is varchar(100); a write failure over a cosmetic overflow
    // would lose the verdict along with it.
    expect(audit.data.model).toHaveLength(100);
  });
});

describe('ClassifyReportStore queue maintenance', () => {
  it('resolves records that burned every attempt, without a synthetic audit row', async () => {
    const prisma = makePrisma();

    expect(await makeStore(prisma).resolveExhausted(NOW, 3)).toBe(1);

    expect(prisma.monitorRecord.updateMany).toHaveBeenCalledWith({
      where: { aiResolvedAt: null, aiAttempts: { gte: 3 } },
      data: { aiResolvedAt: NOW },
    });
    // No attempt produced a result to record, and the previous attempts' audit
    // rows already say why each of them failed. The record stays keyword-only.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('counts only records that still have attempts left', async () => {
    const prisma = makePrisma();

    expect(await makeStore(prisma).countPending(3)).toBe(7);

    expect(prisma.monitorRecord.count).toHaveBeenCalledWith({
      where: { aiResolvedAt: null, aiAttempts: { lt: 3 } },
    });
  });

  it('requeues only resolved records, resetting the claim and the attempt count', async () => {
    const prisma = makePrisma({ updateManyCount: 2 });

    expect(await makeStore(prisma).requeue({ examTime: { gte: NOW } })).toBe(2);

    expect(prisma.monitorRecord.updateMany).toHaveBeenCalledWith({
      where: { examTime: { gte: NOW }, aiResolvedAt: { not: null } },
      // aiAttentionLevel is deliberately NOT cleared: dropping it here would
      // take the level away for as long as the re-run takes.
      data: { aiResolvedAt: null, aiClaimedAt: null, aiAttempts: 0 },
    });
  });
});
