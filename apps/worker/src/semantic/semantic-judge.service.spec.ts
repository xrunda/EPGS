import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SemanticModelClient, SemanticModelRequest } from '@epgs/ai-semantic';
import { SemanticJudgeService } from './semantic-judge.service';
import type { SemanticJudgeCandidate, SemanticJudgeStore } from './semantic-judge.store';

/**
 * The judge loop (issue #87), driven with a FAKE model client and a fake store.
 *
 * No test in this file needs a gateway, an API key, a container or a network:
 * the model is whatever this file says it is. That is the point of the
 * `SemanticModelClient` seam, and it is what lets issue #87's acceptance
 * samples - timeout, invalid JSON, unverifiable evidence, negation, history,
 * suspicion - all be reproduced deterministically.
 *
 * The properties that matter most here, and why:
 *
 *  - NOTHING FAILS CLOSED. Every failure mode is asserted to write a result
 *    whose `decision.filtered` is false. If someone later adds a branch that
 *    filters on an error, these tests are what makes it loud.
 *  - THE ANCHOR IS NOT THE WHOLE STORY. The multi-occurrence case (negated
 *    first clause, documented second clause) asserts that the prompt actually
 *    carried BOTH sentences, because that window - not the verdict - is what
 *    prevents the false negative issue #87 forbids.
 *  - THE LEVEL FOLLOWS THE SURVIVORS. A filter must trigger a recompute; a lost
 *    race (someone else resolved the row) must not.
 */

const INTENT = '本次检查明确发现或疑似存在溃疡性病变；明确否定、单纯既往史不作为本次有效命中。';

/** A fake model client. Records the requests so the prompt can be inspected. */
class FakeModelClient implements SemanticModelClient {
  readonly requests: SemanticModelRequest[] = [];
  calls = 0;

  constructor(
    private readonly behaviour: {
      /** A fixed reply, or one computed per request (for multi-hit batches). */
      reply?: string | ((request: SemanticModelRequest) => string);
      error?: Error;
    },
  ) {}

  async complete(request: SemanticModelRequest) {
    this.calls += 1;
    this.requests.push(request);
    if (this.behaviour.error !== undefined) throw this.behaviour.error;
    const reply =
      typeof this.behaviour.reply === 'function'
        ? this.behaviour.reply(request)
        : (this.behaviour.reply ?? '{}');
    return { raw: reply, modelVersion: 'fake-v1', latencyMs: 5 };
  }
}

/** The verdict JSON a model would return, with the wire's snake_case names. */
function verdictJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    matched: true,
    semantic_status: 'PRESENT',
    confidence: 'HIGH',
    reason: '模型给出的理由',
    evidence: '胃窦见巨大溃疡',
    intent_excludes_history: false,
    ...overrides,
  });
}

/**
 * A candidate whose stored offsets point at the FIRST occurrence of the
 * keyword, exactly as the matcher's dedup constraint leaves them.
 */
function candidate(overrides: Partial<SemanticJudgeCandidate> = {}): SemanticJudgeCandidate {
  const fieldText = overrides.fieldText ?? '胃窦见巨大溃疡。';
  const keyword = overrides.keyword ?? '溃疡';
  const start = overrides.matchStart ?? fieldText.indexOf(keyword);
  return {
    matchId: 'm1',
    monitorRecordId: 'rec1',
    keyword,
    semanticIntent: INTENT,
    matchField: 'FINDINGS',
    matchMode: 'CONTAINS',
    matchStart: start,
    matchEnd: start + keyword.length,
    fieldText,
    reportVersion: 1,
    ...overrides,
  };
}

function makeStore() {
  return {
    // Defaults to one ordinary hit, so a test that is about the MATRIX or the
    // failure taxonomy does not have to restate the queue setup. Tests about
    // batching and claims override it.
    claimBatch: jest.fn(async (_args: unknown): Promise<SemanticJudgeCandidate[]> => [candidate()]),
    applyResult: jest.fn(async (_c: unknown, _r: unknown, _n: unknown) => true),
    resolveSkipped: jest.fn(async (_id: string, _now: Date) => true),
    resolveExhausted: jest.fn(async (_now: Date, _max: number) => 0),
    countPending: jest.fn(async (_max: number) => 0),
    recomputeLevels: jest.fn(async (_ids: readonly string[]) => 0),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    semanticJudgeBatchSize: 10,
    semanticJudgeMaxAttempts: 3,
    semanticJudgeLeaseSeconds: 300,
    semanticJudgeIntervalSeconds: 30,
    ...overrides,
  };
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function build(options: {
  client?: FakeModelClient;
  store?: ReturnType<typeof makeStore>;
  config?: Record<string, unknown>;
  /** false builds the service with no deps, i.e. the judge switched off. */
  deps?: boolean;
}) {
  const store = options.store ?? makeStore();
  const client = options.client ?? new FakeModelClient({ reply: verdictJson() });
  const deps =
    options.deps === false
      ? null
      : {
          client,
          model: 'test-model',
          timeoutMs: 1_000,
          maxTokens: 128,
          // Honour the configured budget so a test can force a narrow window.
          contextCharBudget: (options.config?.semanticContextCharBudget as number) ?? 400,
        };
  const service = new SemanticJudgeService(
    makeConfig(options.config),
    store as unknown as SemanticJudgeStore,
    deps,
  );
  return { service, store, client };
}

/** The result object handed to the store for the first applied attempt. */
function appliedResult(store: ReturnType<typeof makeStore>, index = 0) {
  return store.applyResult.mock.calls[index][1] as {
    outcome: string;
    error: string | null;
    verdict: { semanticStatus: string; confidence: string } | null;
    decision: { filtered: boolean; reason: string };
  };
}

describe('SemanticJudgeService - switching off', () => {
  it('does nothing at all when unconfigured and reports itself disabled', async () => {
    const { service, store, client } = build({ deps: false });

    const summary = await service.runOnce();

    expect(service.isEnabled).toBe(false);
    expect(summary).toEqual({
      enabled: false,
      claimed: 0,
      judged: 0,
      errored: 0,
      skipped: 0,
      exhausted: 0,
      filtered: 0,
      levelsChanged: 0,
      pending: 0,
    });
    // Not even a queue scan: a deployment without the judge must be
    // indistinguishable from pre-#87 behaviour, including in query load.
    expect(store.claimBatch).not.toHaveBeenCalled();
    expect(store.resolveExhausted).not.toHaveBeenCalled();
    expect(client.calls).toBe(0);
  });

  it('never schedules a tick when disabled', () => {
    const { service } = build({ deps: false });
    jest.useFakeTimers();
    try {
      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SemanticJudgeService - results the matrix keeps', () => {
  it.each([
    ['PRESENT', '胃窦见巨大溃疡', 'PRESENT_KEEP'],
    ['SUSPECTED', '胃窦见巨大溃疡', 'SUSPECTED_KEEP'],
    ['UNCERTAIN', '胃窦见巨大溃疡', 'UNCERTAIN_KEEP'],
  ])('keeps a %s hit', async (status, evidence, expectedReason) => {
    const client = new FakeModelClient({
      reply: verdictJson({ semantic_status: status, evidence, matched: status !== 'UNCERTAIN' }),
    });
    const { service, store } = build({ client });

    const summary = await service.runOnce();

    expect(summary.judged).toBe(1);
    expect(summary.filtered).toBe(0);
    expect(summary.levelsChanged).toBe(0);
    expect(appliedResult(store).decision).toEqual({ filtered: false, reason: expectedReason });
  });

  it('keeps a negated hit the model is not sure about', async () => {
    const client = new FakeModelClient({
      reply: verdictJson({
        semantic_status: 'NEGATED',
        confidence: 'MEDIUM',
        matched: false,
        evidence: '胃窦见巨大溃疡',
      }),
    });
    const { service, store } = build({ client });

    await service.runOnce();

    expect(appliedResult(store).decision).toEqual({
      filtered: false,
      reason: 'NEGATED_NOT_HIGH_KEEP',
    });
  });

  it('keeps a history mention when the intent does not exclude history', async () => {
    const client = new FakeModelClient({
      reply: verdictJson({
        semantic_status: 'HISTORY',
        matched: false,
        intent_excludes_history: false,
        evidence: '胃窦见巨大溃疡',
      }),
    });
    const { service, store } = build({ client });

    await service.runOnce();

    // Silence in the intent is not permission to drop a hit.
    expect(appliedResult(store).decision).toEqual({
      filtered: false,
      reason: 'HISTORY_INTENT_INCLUDES_KEEP',
    });
  });

  it('keeps a hit whose verdict contradicts itself', async () => {
    const client = new FakeModelClient({
      reply: verdictJson({ semantic_status: 'NEGATED', matched: true }),
    });
    const { service, store } = build({ client });

    await service.runOnce();

    expect(appliedResult(store).decision).toEqual({
      filtered: false,
      reason: 'MALFORMED_VERDICT_KEEP',
    });
  });
});

describe('SemanticJudgeService - results the matrix filters', () => {
  it('filters a high-confidence negation and recomputes the record level', async () => {
    const client = new FakeModelClient({
      reply: verdictJson({ semantic_status: 'NEGATED', matched: false, confidence: 'HIGH' }),
    });
    const store = makeStore();
    store.recomputeLevels.mockResolvedValueOnce(1);
    const { service } = build({ client, store });

    const summary = await service.runOnce();

    expect(summary.filtered).toBe(1);
    expect(summary.levelsChanged).toBe(1);
    expect(appliedResult(store).decision).toEqual({
      filtered: true,
      reason: 'NEGATED_HIGH_FILTER',
    });
    expect(store.recomputeLevels).toHaveBeenCalledWith(['rec1']);
  });

  it('filters a history hit with an excluding intent', async () => {
    const client = new FakeModelClient({
      reply: verdictJson({
        semantic_status: 'HISTORY',
        matched: false,
        confidence: 'HIGH',
        intent_excludes_history: true,
        evidence: '胃窦见巨大溃疡',
      }),
    });
    const store = makeStore();
    const { service } = build({ client, store });

    await service.runOnce();

    expect(appliedResult(store).decision).toEqual({
      filtered: true,
      reason: 'HISTORY_HIGH_FILTER',
    });
  });
});

describe('SemanticJudgeService - fail-open on every failure', () => {
  it('keeps the hit when the model times out', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const client = new FakeModelClient({ error: abort });
    const { service, store } = build({ client });

    const summary = await service.runOnce();

    expect(client.calls).toBe(1);
    expect(summary.judged).toBe(0);
    expect(summary.errored).toBe(1);
    expect(appliedResult(store)).toMatchObject({
      outcome: 'ERROR',
      error: 'TIMEOUT',
      verdict: null,
      decision: { filtered: false, reason: 'TIMEOUT_KEEP' },
    });
  });

  it('keeps the hit when the transport fails', async () => {
    const client = new FakeModelClient({ error: new TypeError('fetch failed') });
    const { service, store } = build({ client });

    await service.runOnce();

    expect(appliedResult(store).decision).toEqual({
      filtered: false,
      reason: 'NETWORK_KEEP',
    });
  });

  it.each([
    ['no JSON at all', '抱歉，我无法完成。', 'INVALID_JSON_KEEP'],
    ['a truncated object', '{"matched": false, "semantic_status": "NEG', 'INVALID_JSON_KEEP'],
    ['an unknown status', verdictJson({ semantic_status: 'PROBABLY' }), 'UNKNOWN_ENUM_KEEP'],
    [
      'a missing confidence',
      '{"matched":true,"semantic_status":"PRESENT","reason":"x","evidence":"胃窦见巨大溃疡","intent_excludes_history":false}',
      'SCHEMA_INVALID_KEEP',
    ],
  ])('keeps the hit when the reply has %s', async (_label, reply, expectedReason) => {
    const client = new FakeModelClient({ reply });
    const { service, store } = build({ client });

    const summary = await service.runOnce();

    expect(summary.errored).toBe(1);
    expect(appliedResult(store).decision).toEqual({ filtered: false, reason: expectedReason });
  });

  it('discards a verdict whose evidence is not in the text that was sent', async () => {
    // The hallucinated-justification case. The verdict is thrown away entirely
    // rather than half-trusted: we cannot tell whether the status is wrong too.
    const client = new FakeModelClient({
      reply: verdictJson({
        semantic_status: 'NEGATED',
        matched: false,
        evidence: '胃体后壁可见一深大溃疡',
      }),
    });
    const store = makeStore();
    const { service } = build({ client, store });

    const summary = await service.runOnce();

    expect(summary.errored).toBe(1);
    expect(appliedResult(store)).toMatchObject({
      outcome: 'ERROR',
      error: 'EVIDENCE_UNVERIFIED',
      verdict: null,
      decision: { filtered: false, reason: 'EVIDENCE_UNVERIFIED_KEEP' },
    });
  });

  it('quotes evidence from the window, not from elsewhere in the report', async () => {
    // The model quotes a sentence that IS in the report but was NOT shown to it.
    // Text outside the window is not grounding, even though it is real text -
    // otherwise the evidence check would only prove the model can read.
    const fieldText = '胃窦见巨大溃疡，表面覆白苔。降部未见异常。';
    const client = new FakeModelClient({
      reply: verdictJson({
        semantic_status: 'NEGATED',
        matched: false,
        evidence: '降部未见异常',
      }),
    });
    const store = makeStore();
    const { service } = build({ client, store, config: { semanticContextCharBudget: 15 } });
    store.claimBatch.mockResolvedValueOnce([candidate({ fieldText })]);

    await service.runOnce();

    expect(client.requests[0].user).toContain('胃窦见巨大溃疡，表面覆白苔。');
    expect(client.requests[0].user).not.toContain('降部未见异常');
    expect(appliedResult(store)).toMatchObject({
      error: 'EVIDENCE_UNVERIFIED',
      decision: { filtered: false },
    });
  });

  it('never calls the model when no context can be built', async () => {
    // The keyword is no longer in the field (a report replaced after matching)
    // and there are no stored offsets to fall back on.
    const client = new FakeModelClient({ reply: verdictJson() });
    const store = makeStore();
    const { service } = build({ client, store, config: {} });
    store.claimBatch.mockResolvedValueOnce([
      candidate({
        fieldText: '本次检查未见异常。',
        matchStart: null,
        matchEnd: null,
      }),
    ]);

    const summary = await service.runOnce();

    expect(client.calls).toBe(0);
    expect(summary.errored).toBe(1);
    expect(appliedResult(store)).toMatchObject({
      error: 'EMPTY_CONTEXT',
      decision: { filtered: false, reason: 'EMPTY_CONTEXT_KEEP' },
    });
  });
});

describe('SemanticJudgeService - the multi-occurrence hazard', () => {
  it('sends the whole window and keeps a report that documents the finding', async () => {
    // THE case this feature must not get wrong. The surviving match row anchors
    // on the FIRST occurrence, which here is the negated one; the report then
    // documents an ulcer in the next clause. Judging the anchor alone would
    // filter a real finding.
    const fieldText = '十二指肠球部未见明显溃疡；胃窦见巨大溃疡。';
    const client = new FakeModelClient({
      reply: verdictJson({ semantic_status: 'PRESENT', matched: true, evidence: '胃窦见巨大溃疡' }),
    });
    const store = makeStore();
    const { service } = build({ client, store });
    store.claimBatch.mockResolvedValueOnce([
      candidate({
        fieldText,
        matchStart: fieldText.indexOf('溃疡'),
        matchEnd: fieldText.indexOf('溃疡') + 2,
      }),
    ]);

    const summary = await service.runOnce();

    // Both clauses reached the model: the window, not luck, is what makes the
    // verdict safe.
    expect(client.requests[0].user).toContain('未见明显溃疡');
    expect(client.requests[0].user).toContain('胃窦见巨大溃疡');
    expect(summary.filtered).toBe(0);
    expect(appliedResult(store).decision.filtered).toBe(false);
  });

  it('re-derives the anchor for a hit recorded before the offsets existed', async () => {
    const fieldText = '胃窦见巨大溃疡，表面覆白苔。';
    const client = new FakeModelClient({ reply: verdictJson({ evidence: '胃窦见巨大溃疡' }) });
    const store = makeStore();
    const { service } = build({ client, store });
    store.claimBatch.mockResolvedValueOnce([
      candidate({ fieldText, matchStart: null, matchEnd: null }),
    ]);

    await service.runOnce();

    expect(client.calls).toBe(1);
    expect(client.requests[0].user).toContain('胃窦见巨大溃疡，表面覆白苔。');
  });
});

describe('SemanticJudgeService - what is never judged', () => {
  it('skips a rule with no semantic intent, without calling the model', async () => {
    const client = new FakeModelClient({ reply: verdictJson() });
    const store = makeStore();
    const { service } = build({ client, store });
    store.claimBatch.mockResolvedValueOnce([candidate({ semanticIntent: null })]);

    const summary = await service.runOnce();

    expect(client.calls).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(store.resolveSkipped).toHaveBeenCalledWith('m1', expect.any(Date));
    expect(store.applyResult).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['whitespace', '   \n '],
  ])('treats a %s intent as unconfigured', async (_label, semanticIntent) => {
    const client = new FakeModelClient({ reply: verdictJson() });
    const store = makeStore();
    const { service } = build({ client, store });
    store.claimBatch.mockResolvedValueOnce([candidate({ semanticIntent })]);

    await service.runOnce();

    expect(client.calls).toBe(0);
    expect(store.resolveSkipped).toHaveBeenCalledTimes(1);
  });

  it('skips a hit whose field has no text source', async () => {
    const client = new FakeModelClient({ reply: verdictJson() });
    const store = makeStore();
    const { service } = build({ client, store });
    store.claimBatch.mockResolvedValueOnce([candidate({ matchField: 'OTHER', fieldText: null })]);

    const summary = await service.runOnce();

    expect(client.calls).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

describe('SemanticJudgeService - batching, claims and levels', () => {
  it('does not recompute a record whose verdict lost the race', async () => {
    const store = makeStore();
    store.applyResult.mockResolvedValue(false);
    const { service } = build({ store });
    store.claimBatch.mockResolvedValueOnce([candidate()]);

    await service.runOnce();

    // Someone else settled the row, so they own the recompute.
    expect(store.recomputeLevels).toHaveBeenCalledWith([]);
  });

  it('recomputes each affected record once for the whole batch', async () => {
    const store = makeStore();
    const { service } = build({ store });
    store.claimBatch.mockResolvedValueOnce([
      candidate({ matchId: 'm1', monitorRecordId: 'rec1' }),
      candidate({ matchId: 'm2', monitorRecordId: 'rec1', keyword: '白苔' }),
      candidate({ matchId: 'm3', monitorRecordId: 'rec2' }),
    ]);

    await service.runOnce();

    expect(store.recomputeLevels).toHaveBeenCalledTimes(1);
    expect(store.recomputeLevels).toHaveBeenCalledWith(['rec1', 'rec2']);
  });

  it('judges several keywords in one report independently', async () => {
    const store = makeStore();
    // Each hit is judged on its own excerpt, so the fake answers per request.
    const client = new FakeModelClient({
      reply: (request) =>
        verdictJson({
          evidence: request.user.includes('白苔') ? '表面覆白苔' : '胃窦见巨大溃疡',
        }),
    });
    const { service } = build({ store, client });
    store.claimBatch.mockResolvedValueOnce([
      candidate({ matchId: 'm1', keyword: '溃疡', fieldText: '胃窦见巨大溃疡。' }),
      candidate({ matchId: 'm2', keyword: '白苔', fieldText: '表面覆白苔。' }),
    ]);

    const summary = await service.runOnce();

    expect(summary.judged).toBe(2);
    expect(client.calls).toBe(2);
    expect(store.applyResult).toHaveBeenCalledTimes(2);
  });

  it('drains poisoned rows before claiming, and reports the backlog', async () => {
    const store = makeStore();
    store.resolveExhausted.mockResolvedValueOnce(4);
    store.countPending.mockResolvedValueOnce(7);
    const { service } = build({ store });

    const summary = await service.runOnce();

    expect(summary.exhausted).toBe(4);
    expect(summary.pending).toBe(7);
    // Draining first is what stops a poison row from taking a batch slot on
    // every single tick.
    expect(store.resolveExhausted.mock.invocationCallOrder[0]).toBeLessThan(
      store.claimBatch.mock.invocationCallOrder[0],
    );
  });

  it('keeps claiming while batches come back full, and stops on a short one', async () => {
    const store = makeStore();
    store.claimBatch
      .mockResolvedValueOnce([candidate({ matchId: 'm1' }), candidate({ matchId: 'm2' })])
      .mockResolvedValueOnce([candidate({ matchId: 'm3' })]);
    const { service } = build({ store, config: { semanticJudgeBatchSize: 2 } });

    const summary = await service.runOnce({ maxBatches: 10 });

    expect(store.claimBatch).toHaveBeenCalledTimes(2);
    expect(summary.claimed).toBe(3);
    expect(summary.judged).toBe(3);
  });

  it('honours maxBatches even when the queue is full', async () => {
    const store = makeStore();
    store.claimBatch.mockResolvedValue([candidate(), candidate()]);
    const { service } = build({ store, config: { semanticJudgeBatchSize: 2 } });

    const summary = await service.runOnce({ maxBatches: 2 });

    expect(store.claimBatch).toHaveBeenCalledTimes(2);
    expect(summary.claimed).toBe(4);
  });

  it('refuses to overlap with itself inside one process', async () => {
    const store = makeStore();
    let release: ((rows: SemanticJudgeCandidate[]) => void) | undefined;
    store.claimBatch.mockReturnValueOnce(
      new Promise<SemanticJudgeCandidate[]>((resolve) => {
        release = resolve;
      }),
    );
    const { service } = build({ store });

    const inFlight = service.runOnce();
    const overlapping = await service.runOnce();

    expect(overlapping.claimed).toBe(0);
    expect(overlapping.enabled).toBe(true);
    release?.([]);
    await inFlight;
    expect(store.claimBatch).toHaveBeenCalledTimes(1);
  });
});

describe('SemanticJudgeService - the logging contract', () => {
  it('logs machine codes and counts, never the report text or the model free text', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const client = new FakeModelClient({
        reply: verdictJson({
          semantic_status: 'NEGATED',
          matched: false,
          // Must be text that is actually in the field below, or the attempt
          // fails evidence verification and this stops testing a filter.
          evidence: '未见明显溃疡',
          reason: '这句话说的是没有看到病变',
        }),
      });
      const store = makeStore();
      const { service } = build({ client, store });
      store.claimBatch.mockResolvedValueOnce([
        candidate({ fieldText: '十二指肠球部未见明显溃疡。' }),
      ]);

      await service.runOnce();

      const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
      // A filter and a failure are both logged - but only as codes.
      expect(logged).toContain('NEGATED_HIGH_FILTER');
      expect(logged).not.toContain('未见明显溃疡');
      expect(logged).not.toContain('这句话说的是没有看到病变');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('logs the failure code when an attempt fails', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const client = new FakeModelClient({ error: new TypeError('fetch failed') });
      const store = makeStore();
      const { service } = build({ client, store });
      store.claimBatch.mockResolvedValueOnce([candidate()]);

      await service.runOnce();

      const logged = warnSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('NETWORK');
      expect(logged).toContain('NETWORK_KEEP');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
