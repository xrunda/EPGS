import { ConfigService } from '@nestjs/config';
import type {
  AttentionSemanticSnapshot,
  SemanticModelClient,
  SemanticModelRequest,
} from '@epgs/ai-semantic';
import { ClassifyReportService } from './classify.service';
import type { ClassifyRecordCandidate, ClassifyReportStore } from './classify.store';

/**
 * The classifier loop (issue #88), driven with a FAKE model client and a fake
 * store.
 *
 * No test here needs a gateway, an API key, a container or a network: the model
 * is whatever this file says it is. That is the point of the
 * `SemanticModelClient` seam, and it is what lets the acceptance samples -
 * timeout, invalid JSON, forged evidence, an unknown semantic, an incoherent
 * level - all be reproduced deterministically.
 *
 * The properties that matter most here, and why:
 *
 *  - NOTHING FAILS LOUDLY IN THE WRONG DIRECTION. Every failure ends with NO AI
 *    finding, and the summary distinguishes "errored" (an attempt failed) from
 *    "no semantics configured" (nothing was even attempted), because those two
 *    look identical to an operator whose dashboard is flat.
 *  - THE BACKLOG IS NOT DRAINED WHILE UNCONFIGURED. With no enabled semantics
 *    the loop must not claim anything: claiming and resolving would mark the
 *    queue done while there was nothing to judge against, and those reports
 *    would never be classified once the hospital configured its semantics.
 *  - THE LEVEL MOVES ONLY WHEN THE STORE SAYS IT DID, and a lost race reports
 *    zero.
 */

const REPORT_TEXT = '胃体见巨大不规则隆起，表面糜烂，质脆，触之易出血。';
const DIAGNOSIS_TEXT = '胃体占位性病变，性质待定。';

const SEMANTICS: AttentionSemanticSnapshot[] = [
  {
    id: 'sem-red',
    version: 1,
    attentionLevel: 'RED',
    name: '明确或高度疑似恶性病变',
    description: '报告明确描述恶性征象',
  },
  {
    id: 'sem-yellow',
    version: 3,
    attentionLevel: 'YELLOW',
    name: '性质待定、需活检的病变',
    description: '报告提示性质待定',
  },
];

/** A fake model client. Records the requests so the prompt can be inspected. */
class FakeModelClient implements SemanticModelClient {
  readonly requests: SemanticModelRequest[] = [];
  calls = 0;

  constructor(
    private readonly behaviour: {
      /** One reply for every call. */
      reply?: string;
      error?: Error;
    } = {},
  ) {}

  async complete(request: SemanticModelRequest) {
    this.calls += 1;
    this.requests.push(request);
    if (this.behaviour.error !== undefined) throw this.behaviour.error;
    return { raw: this.behaviour.reply ?? '{}', modelVersion: 'fake-v1', latencyMs: 9 };
  }
}

/** The reply JSON a model would return, with the wire's snake_case names. */
function replyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    attention_level: 'RED',
    matches: [
      {
        semantic_id: 'sem-red',
        confidence: 'HIGH',
        reason: '报告描述了巨大不规则隆起并伴糜烂出血',
        evidence: ['胃体见巨大不规则隆起'],
      },
    ],
    ...overrides,
  });
}

function candidate(overrides: Partial<ClassifyRecordCandidate> = {}): ClassifyRecordCandidate {
  return {
    monitorRecordId: 'rec1',
    reportVersion: 1,
    examItem: '电子胃镜检查',
    reportContent: REPORT_TEXT,
    diagnosis: DIAGNOSIS_TEXT,
    ...overrides,
  };
}

function makeStore(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    loadEnabledSemantics: jest.fn(async () => SEMANTICS as AttentionSemanticSnapshot[]),
    claimBatch: jest.fn(async (_args: unknown): Promise<ClassifyRecordCandidate[]> => [
      candidate(),
    ]),
    applyResult: jest.fn(async (_c: unknown, _r: unknown, _n: unknown) => ({
      resolved: true,
      levelsChanged: 0,
    })),
    resolveExhausted: jest.fn(async (_now: Date, _max: number) => 0),
    countPending: jest.fn(async (_max: number) => 0),
    requeue: jest.fn(async (_where: unknown) => 0),
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    semanticReportBatchSize: 5,
    semanticReportMaxAttempts: 3,
    semanticReportLeaseSeconds: 600,
    semanticReportIntervalSeconds: 60,
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
  /** false builds the service with no deps, i.e. the classifier switched off. */
  deps?: boolean;
  /** Drops the report text, to exercise the EMPTY_INPUT path. */
  emptyReport?: boolean;
} = {}) {
  const store = options.store ?? makeStore();
  const client = options.client ?? new FakeModelClient({ reply: replyJson() });
  if (options.emptyReport) {
    store.claimBatch.mockResolvedValue([
      candidate({ examItem: null, reportContent: null, diagnosis: null }),
    ]);
  }
  const deps =
    options.deps === false
      ? null
      : { client, model: 'test-model', timeoutMs: 20_000, maxTokens: 1_024 };
  const service = new ClassifyReportService(
    makeConfig(options.config),
    store as unknown as ClassifyReportStore,
    deps,
  );
  return { service, store, client };
}

/** The result object handed to the store for the first applied attempt. */
function appliedResult(store: ReturnType<typeof makeStore>, index = 0) {
  return store.applyResult.mock.calls[index][1] as {
    outcome: string;
    error: string | null;
    attentionLevel: string | null;
    modelAttentionLevel: string | null;
    matches: { semanticId: string; attentionLevel: string }[];
  };
}

describe('ClassifyReportService - switching off', () => {
  it('does nothing at all when unconfigured and reports itself disabled', async () => {
    const { service, store, client } = build({ deps: false });

    const summary = await service.runOnce();

    expect(service.isEnabled).toBe(false);
    expect(summary).toEqual({
      enabled: false,
      noSemantics: false,
      claimed: 0,
      classified: 0,
      errored: 0,
      withMatches: 0,
      exhausted: 0,
      levelsChanged: 0,
      pending: 0,
    });
    // Not even a queue scan: a deployment without the classifier must be
    // indistinguishable from pre-#88 behaviour, including in query load.
    expect(store.loadEnabledSemantics).not.toHaveBeenCalled();
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

describe('ClassifyReportService - nothing to judge against', () => {
  it('claims nothing and leaves the backlog pending when no semantic is enabled', async () => {
    const store = makeStore({ loadEnabledSemantics: jest.fn(async () => []) });
    const { service, client } = build({ store });

    const summary = await service.runOnce();

    // The important half: the backlog is NOT drained. Claiming and resolving
    // would mark every report done while there was nothing to judge them
    // against, and they would never be classified once the hospital finally
    // configured its semantics.
    expect(store.claimBatch).not.toHaveBeenCalled();
    expect(client.calls).toBe(0);
    expect(summary).toMatchObject({ enabled: true, noSemantics: true, claimed: 0, pending: 0 });
    expect(store.countPending).toHaveBeenCalledWith(3);
  });

  it('warns once, not on every tick', async () => {
    const store = makeStore({ loadEnabledSemantics: jest.fn(async () => []) });
    const { service } = build({ store });
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    await service.runOnce();
    await service.runOnce();
    await service.runOnce();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no attention semantic is enabled');
  });

  it('reports nothing for a genuine empty queue: no semantics call is even a problem', async () => {
    const store = makeStore({ claimBatch: jest.fn(async () => []) });
    const { service } = build({ store });

    const summary = await service.runOnce();

    expect(summary).toMatchObject({ noSemantics: false, claimed: 0, classified: 0, errored: 0 });
    expect(store.resolveExhausted).toHaveBeenCalledTimes(1);
  });
});

describe('ClassifyReportService - results the audit keeps', () => {
  it('applies a verified match, with the CONFIGURED colour rather than the model one', async () => {
    const { service, store } = build();

    const summary = await service.runOnce();

    expect(summary).toMatchObject({ claimed: 1, classified: 1, errored: 0, withMatches: 1 });
    expect(appliedResult(store)).toMatchObject({
      outcome: 'OK',
      error: null,
      attentionLevel: 'RED',
      modelAttentionLevel: 'RED',
      matches: [{ semanticId: 'sem-red', attentionLevel: 'RED' }],
    });
  });

  it('keeps EVERY verified match, not only the highest', async () => {
    const client = new FakeModelClient({
      reply: replyJson({
        attention_level: 'RED',
        matches: [
          {
            semantic_id: 'sem-yellow',
            confidence: 'MEDIUM',
            reason: '性质待定',
            evidence: ['性质待定'],
          },
          {
            semantic_id: 'sem-red',
            confidence: 'HIGH',
            reason: '恶性征象',
            evidence: ['胃体见巨大不规则隆起'],
          },
        ],
      }),
    });
    const { service, store } = build({ client });

    await service.runOnce();

    const result = appliedResult(store);
    // All of them - the level is the maximum, but the audit trail is the whole
    // set, so a doctor can see everything the model found.
    expect(result.matches.map((match) => match.semanticId)).toEqual(['sem-yellow', 'sem-red']);
    expect(result.attentionLevel).toBe('RED');
  });

  it('records a genuine NONE as an OK attempt with no matches', async () => {
    const client = new FakeModelClient({ reply: replyJson({ attention_level: 'NONE', matches: [] }) });
    const { service, store } = build({ client });

    const summary = await service.runOnce();

    expect(summary).toMatchObject({ classified: 1, withMatches: 0, errored: 0 });
    expect(appliedResult(store)).toMatchObject({
      outcome: 'OK',
      attentionLevel: null,
      modelAttentionLevel: 'NONE',
      matches: [],
    });
  });

  it('reports the level moves the store made, and only those', async () => {
    const store = makeStore({
      applyResult: jest.fn(async () => ({ resolved: true, levelsChanged: 1 })),
    });
    const { service } = build({ store });

    expect((await service.runOnce()).levelsChanged).toBe(1);
  });

  it('counts a lost race as neither classified nor a level move', async () => {
    const store = makeStore({
      applyResult: jest.fn(async () => ({ resolved: false, levelsChanged: 0 })),
    });
    const { service } = build({ store });

    const summary = await service.runOnce();

    // The attempt still happened and was recorded - it just did not settle the
    // record, because someone else did.
    expect(summary).toMatchObject({ claimed: 1, classified: 1, levelsChanged: 0 });
  });
});

describe('ClassifyReportService - every failure produces NO finding', () => {
  it.each([
    [
      'a timeout',
      () => new FakeModelClient({ error: Object.assign(new Error('timed out'), { name: 'AbortError' }) }),
      'TIMEOUT',
    ],
    // Node's fetch rejects a genuine transport failure with a TypeError.
    ['a transport error', () => new FakeModelClient({ error: new TypeError('fetch failed') }), 'NETWORK'],
    // Anything else from the call path, so an unforeseen bug is still an
    // audit row rather than an exception the loop has to swallow.
    ['an unexpected error', () => new FakeModelClient({ error: new Error('boom') }), 'MODEL_ERROR'],
    ['an unparseable reply', () => new FakeModelClient({ reply: '抱歉，我无法完成。' }), 'INVALID_JSON'],
    [
      'a mistyped field',
      () => new FakeModelClient({ reply: JSON.stringify({ attention_level: 'RED' }) }),
      'SCHEMA_INVALID',
    ],
    [
      'an invented level',
      () => new FakeModelClient({ reply: replyJson({ attention_level: 'CRITICAL' }) }),
      'UNKNOWN_ENUM',
    ],
    [
      'a semantic the hospital never configured',
      () =>
        new FakeModelClient({
          reply: replyJson({
            matches: [
              {
                semantic_id: 'sem-invented',
                confidence: 'HIGH',
                reason: '理由',
                evidence: ['胃体见巨大不规则隆起'],
              },
            ],
          }),
        }),
      'UNKNOWN_SEMANTIC',
    ],
    [
      'an excerpt that is not in the report',
      () =>
        new FakeModelClient({
          reply: replyJson({
            matches: [
              {
                semantic_id: 'sem-red',
                confidence: 'HIGH',
                reason: '理由',
                evidence: ['十二指肠球部见溃疡'],
              },
            ],
          }),
        }),
      'EVIDENCE_UNVERIFIED',
    ],
    [
      'a level that disagrees with the matches it returned',
      () =>
        new FakeModelClient({
          reply: replyJson({
            matches: [
              {
                semantic_id: 'sem-yellow',
                confidence: 'HIGH',
                reason: '理由',
                evidence: ['性质待定'],
              },
            ],
          }),
        }),
      'INCOHERENT_LEVEL',
    ],
  ])('records %s as an ERROR with zero matches', async (_name, makeClient, code) => {
    const { service, store } = build({ client: makeClient() });

    const summary = await service.runOnce();

    expect(summary).toMatchObject({ claimed: 1, classified: 0, errored: 1, withMatches: 0 });
    const result = appliedResult(store);
    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe(code);
    // The whole point of the fail-safe direction: a failure produces NO finding,
    // not a partial one - so the keyword path is left exactly as it was.
    expect(result.matches).toEqual([]);
    expect(result.attentionLevel).toBeNull();
  });

  it('produces no finding for a record with no report text, without calling the model', async () => {
    const { service, store, client } = build({ emptyReport: true });

    const summary = await service.runOnce();

    expect(summary).toMatchObject({ errored: 1 });
    expect(appliedResult(store).error).toBe('EMPTY_INPUT');
    expect(client.calls).toBe(0);
  });

  it('keeps going after a failed record rather than aborting the batch', async () => {
    const store = makeStore({
      claimBatch: jest.fn(async () => [candidate(), candidate({ monitorRecordId: 'rec2' })]),
    });
    const client = new FakeModelClient({ error: new Error('fetch failed') });
    const { service } = build({ store, client });

    const summary = await service.runOnce();

    // Failure isolation: one bad record (or one gateway hiccup) must not stop
    // the rest of the batch from being attempted.
    expect(client.calls).toBe(2);
    expect(summary).toMatchObject({ claimed: 2, errored: 2 });
    expect(store.applyResult).toHaveBeenCalledTimes(2);
  });
});

describe('ClassifyReportService - batching and cadence', () => {
  it('stops after a short batch rather than paying for an empty claim query', async () => {
    const store = makeStore({ claimBatch: jest.fn(async () => [candidate()]) });
    const { service } = build({ store });

    await service.runOnce({ maxBatches: 10 });

    // One batch of 1 with a batchSize of 5 means the queue is drained.
    expect(store.claimBatch).toHaveBeenCalledTimes(1);
  });

  it('drains exhausted records BEFORE claiming, so a poison record cannot hold a slot', async () => {
    const calls: string[] = [];
    const store = makeStore({
      resolveExhausted: jest.fn(async () => {
        calls.push('resolveExhausted');
        return 2;
      }),
      claimBatch: jest.fn(async () => {
        calls.push('claimBatch');
        return [candidate()];
      }),
    });
    const { service } = build({ store });

    const summary = await service.runOnce();

    expect(calls).toEqual(['resolveExhausted', 'claimBatch']);
    expect(summary.exhausted).toBe(2);
  });

  it('refuses to start a second run while one is in progress in this process', async () => {
    // The gate holds the first run open at its very first await, so "a run is
    // already in progress" is a fact rather than a race with the scheduler.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = makeStore({
      resolveExhausted: jest.fn(async () => {
        await gate;
        return 0;
      }),
    });
    const { service, client } = build({ store });

    const first = service.runOnce();
    const second = await service.runOnce();

    // A tick that fires while the previous one is still running must not start a
    // second overlapping pass - the flag is set before the first await.
    expect(second.claimed).toBe(0);
    expect(store.claimBatch).not.toHaveBeenCalled();
    expect(client.calls).toBe(0);

    release();
    await first;
    expect(client.calls).toBe(1);
    // And the flag is released, so the loop still works after a run that threw.
    const third = await service.runOnce();
    expect(third.claimed).toBe(1);
  });

  it('reads the semantics ONCE per run, so configHash means the same thing for every record', async () => {
    const store = makeStore({
      claimBatch: jest.fn(async () => [candidate(), candidate({ monitorRecordId: 'rec2' })]),
    });
    const { service } = build({ store });

    await service.runOnce();

    expect(store.loadEnabledSemantics).toHaveBeenCalledTimes(1);
  });
});

describe('ClassifyReportService - the prompt', () => {
  it('sends the report sections and every enabled semantic', async () => {
    const { service, client } = build();

    await service.runOnce();

    const request = client.requests[0];
    expect(request.user).toContain(REPORT_TEXT);
    expect(request.user).toContain(DIAGNOSIS_TEXT);
    expect(request.user).toContain('电子胃镜检查');
    expect(request.user).toContain('sem-red');
    expect(request.user).toContain('明确或高度疑似恶性病变');
    // The configured colour is what the model is asked to reason about, and it
    // is also what the code will use to compute the level.
    expect(request.user).toContain('RED');
    expect(request.model).toBe('test-model');
  });

  it('never logs the report text or the model reason', async () => {
    const { service } = build();
    const logged: string[] = [];
    for (const method of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(service['logger'], method)
        .mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }

    await service.runOnce();

    const written = logged.join('\n');
    expect(written).not.toContain(REPORT_TEXT);
    expect(written).not.toContain(DIAGNOSIS_TEXT);
    expect(written).not.toContain('报告描述了巨大不规则隆起并伴糜烂出血');
    // Ids, counts and machine codes are fine and are what an operator needs.
    expect(written).toContain('rec1');
  });
});
