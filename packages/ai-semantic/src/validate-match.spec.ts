import { validateMatch, ValidateMatchDeps } from './validate-match';
import { SemanticError } from './errors';
import type {
  SemanticModelClient,
  SemanticModelRequest,
  SemanticModelResponse,
} from './model-client';
import { ValidateMatchInput } from './types';

/**
 * Validate Match end to end, with a fake model.
 *
 * No test in this file needs a real model, a network or a container: the
 * `SemanticModelClient` seam is what makes the whole acceptance list offline
 * and deterministic. The samples mirror issue #87's required list, using real
 * Chinese report phrasing so the context-window behaviour is exercised on the
 * shapes that actually occur.
 */

/** A fake model that always returns a canned reply, or always throws. */
class FakeModelClient implements SemanticModelClient {
  readonly requests: SemanticModelRequest[] = [];

  constructor(
    private readonly behaviour:
      | { kind: 'reply'; raw: string; modelVersion?: string | null }
      | { kind: 'throw'; error: unknown },
  ) {}

  async complete(request: SemanticModelRequest): Promise<SemanticModelResponse> {
    this.requests.push(request);
    if (this.behaviour.kind === 'throw') {
      throw this.behaviour.error;
    }
    return {
      raw: this.behaviour.raw,
      modelVersion: this.behaviour.modelVersion ?? 'test-model-2026-01',
      latencyMs: 42,
    };
  }
}

/** Build the JSON reply the model is contracted to produce. */
function reply(fields: {
  matched: boolean;
  semanticStatus: string;
  confidence: string;
  reason?: string;
  evidence: string;
  intentExcludesHistory?: boolean;
}): string {
  return JSON.stringify({
    matched: fields.matched,
    semantic_status: fields.semanticStatus,
    confidence: fields.confidence,
    reason: fields.reason ?? '测试理由',
    evidence: fields.evidence,
    intent_excludes_history: fields.intentExcludesHistory ?? false,
  });
}

const DEFAULT_INTENT =
  '本次检查明确发现或疑似存在溃疡性病变；明确否定、单纯既往史不作为本次有效命中。';

function deps(
  client: SemanticModelClient,
  overrides: Partial<ValidateMatchDeps> = {},
): ValidateMatchDeps {
  return { client, model: 'hospital-gateway-model', ...overrides };
}

/**
 * Build a Validate Match input by locating the keyword in the text, so tests
 * never hand-write offsets (which would let a test pass while the offsets the
 * worker actually produces are wrong).
 */
function inputFor(
  fieldText: string,
  keyword: string,
  overrides: Partial<ValidateMatchInput> = {},
): ValidateMatchInput {
  const start = fieldText.indexOf(keyword);
  if (start === -1) {
    throw new Error(`test setup: keyword ${keyword} not in text`);
  }
  return {
    keyword,
    semanticIntent: DEFAULT_INTENT,
    fieldText,
    matchStart: start,
    matchEnd: start + keyword.length,
    matchMode: 'CONTAINS',
    matchField: 'FINDINGS',
    reportVersion: 1,
    ...overrides,
  };
}

describe('validateMatch - the required acceptance samples', () => {
  it('胃窦见巨大溃疡 -> PRESENT -> kept, with verified evidence', async () => {
    const text = '胃窦见巨大溃疡，表面覆白苔，周围黏膜充血水肿。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'PRESENT',
        confidence: 'HIGH',
        evidence: '胃窦见巨大溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.outcome).toBe('OK');
    expect(result.verdict?.semanticStatus).toBe('PRESENT');
    expect(result.decision).toEqual({ filtered: false, reason: 'PRESENT_KEEP' });
    expect(result.evidence).not.toBeNull();
    expect(result.error).toBeNull();
  });

  it('未见明显溃疡 -> NEGATED + HIGH -> filtered', async () => {
    const text = '十二指肠球部未见明显溃疡，黏膜光滑。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: false,
        semanticStatus: 'NEGATED',
        confidence: 'HIGH',
        evidence: '未见明显溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.outcome).toBe('OK');
    expect(result.decision).toEqual({ filtered: true, reason: 'NEGATED_HIGH_FILTER' });
  });

  it('胃溃疡病史 with an intent that excludes history -> HISTORY + HIGH -> filtered', async () => {
    const text = '患者既往胃溃疡病史 5 年，本次复查。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: false,
        semanticStatus: 'HISTORY',
        confidence: 'HIGH',
        evidence: '既往胃溃疡病史 5 年',
        intentExcludesHistory: true,
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.decision).toEqual({ filtered: true, reason: 'HISTORY_HIGH_FILTER' });
  });

  it('考虑胃溃疡可能 -> SUSPECTED -> kept', async () => {
    const text = '胃角黏膜粗糙，考虑胃溃疡可能，建议活检。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'SUSPECTED',
        confidence: 'MEDIUM',
        evidence: '考虑胃溃疡可能',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.decision).toEqual({ filtered: false, reason: 'SUSPECTED_KEEP' });
  });

  it('不能除外溃疡 -> SUSPECTED -> kept', async () => {
    const text = '局部黏膜隆起，不能除外溃疡，建议进一步检查。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'SUSPECTED',
        confidence: 'MEDIUM',
        evidence: '不能除外溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.decision.filtered).toBe(false);
    expect(result.decision.reason).toBe('SUSPECTED_KEEP');
  });

  it('insufficient context -> UNCERTAIN -> kept', async () => {
    const text = '溃疡。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: false,
        semanticStatus: 'UNCERTAIN',
        confidence: 'LOW',
        evidence: '溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.decision).toEqual({ filtered: false, reason: 'UNCERTAIN_KEEP' });
  });

  it('AI timeout -> kept, with no call result recorded', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const client = new FakeModelClient({ kind: 'throw', error: abort });

    const result = await validateMatch(inputFor('胃窦见溃疡。', '溃疡'), deps(client));

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('TIMEOUT');
    expect(result.verdict).toBeNull();
    expect(result.decision).toEqual({ filtered: false, reason: 'TIMEOUT_KEEP' });
    expect(result.latencyMs).toBeNull();
  });

  it('AI invalid JSON -> kept', async () => {
    const client = new FakeModelClient({ kind: 'reply', raw: '抱歉，我无法完成这个请求。' });

    const result = await validateMatch(inputFor('胃窦见溃疡。', '溃疡'), deps(client));

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('INVALID_JSON');
    expect(result.decision).toEqual({ filtered: false, reason: 'INVALID_JSON_KEEP' });
  });

  it('evidence not present in the source -> kept, and the verdict is discarded', async () => {
    const text = '十二指肠球部未见明显溃疡。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: false,
        semanticStatus: 'NEGATED',
        confidence: 'HIGH',
        // A fluent, plausible justification that is nowhere in the excerpt.
        evidence: '胃窦后壁可见一深大溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('EVIDENCE_UNVERIFIED');
    // The critical assertion: a NEGATED+HIGH verdict that would otherwise have
    // filtered does NOT filter once its evidence cannot be located.
    expect(result.decision).toEqual({ filtered: false, reason: 'EVIDENCE_UNVERIFIED_KEEP' });
    expect(result.verdict).toBeNull();
  });

  it('NEGATED + LOW -> kept', async () => {
    const text = '未见明显溃疡。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: false,
        semanticStatus: 'NEGATED',
        confidence: 'LOW',
        evidence: '未见明显溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.decision).toEqual({ filtered: false, reason: 'NEGATED_NOT_HIGH_KEEP' });
  });
});

describe('validateMatch - failure isolation', () => {
  it.each([
    ['NETWORK', new TypeError('fetch failed')],
    ['MODEL_ERROR', new Error('unexpected')],
  ])('%s -> kept', async (expectedCode, error) => {
    const client = new FakeModelClient({ kind: 'throw', error });
    const result = await validateMatch(inputFor('胃窦见溃疡。', '溃疡'), deps(client));

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe(expectedCode);
    expect(result.decision.filtered).toBe(false);
  });

  it('an HTTP status failure keeps the status in the error code', async () => {
    const client = new FakeModelClient({
      kind: 'throw',
      error: new SemanticError('HTTP_503', 'gateway unavailable'),
    });

    const result = await validateMatch(inputFor('胃窦见溃疡。', '溃疡'), deps(client));

    expect(result.error).toBe('HTTP_503');
    expect(result.decision).toEqual({ filtered: false, reason: 'HTTP_ERROR_KEEP' });
  });

  it('an unknown enum value is reported distinctly and kept', async () => {
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: false,
        semanticStatus: 'PROBABLY',
        confidence: 'HIGH',
        evidence: '溃疡',
      }),
    });

    const result = await validateMatch(inputFor('未见溃疡。', '溃疡'), deps(client));

    expect(result.error).toBe('UNKNOWN_ENUM');
    expect(result.decision).toEqual({ filtered: false, reason: 'UNKNOWN_ENUM_KEEP' });
  });

  it('a missing field is SCHEMA_INVALID and kept', async () => {
    const client = new FakeModelClient({
      kind: 'reply',
      raw: JSON.stringify({ matched: false, semantic_status: 'NEGATED', confidence: 'HIGH' }),
    });

    const result = await validateMatch(inputFor('未见溃疡。', '溃疡'), deps(client));

    expect(result.error).toBe('SCHEMA_INVALID');
    expect(result.decision).toEqual({ filtered: false, reason: 'SCHEMA_INVALID_KEEP' });
  });

  it('never throws, whatever the client does', async () => {
    const client: SemanticModelClient = {
      complete() {
        throw 'not even an Error object';
      },
    };

    await expect(
      validateMatch(inputFor('胃窦见溃疡。', '溃疡'), deps(client)),
    ).resolves.toMatchObject({
      outcome: 'ERROR',
      error: 'MODEL_ERROR',
    });
  });

  it('does not call the model at all when the anchor cannot be located', async () => {
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({ matched: false, semanticStatus: 'NEGATED', confidence: 'HIGH', evidence: 'x' }),
    });

    const result = await validateMatch(
      {
        keyword: '溃疡',
        semanticIntent: DEFAULT_INTENT,
        fieldText: '胃窦见溃疡。',
        // Offsets beyond the end of the field: cannot be trusted, so no call.
        matchStart: 900,
        matchEnd: 902,
      },
      deps(client),
    );

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('EMPTY_CONTEXT');
    expect(result.decision).toEqual({ filtered: false, reason: 'EMPTY_CONTEXT_KEEP' });
    expect(client.requests).toHaveLength(0);
  });

  it('is disabled for a rule with no semantic intent, when the caller skips it', async () => {
    // The skip is the caller's job (one query for the whole batch); this
    // asserts the shared predicate the caller uses to decide.
    const { semanticIntentConfigured } = await import('./types');
    expect(semanticIntentConfigured(null)).toBe(false);
    expect(semanticIntentConfigured('')).toBe(false);
    expect(semanticIntentConfigured('   ')).toBe(false);
    expect(semanticIntentConfigured('关注本次活动性溃疡')).toBe(true);
  });
});

describe('validateMatch - context window', () => {
  it('covers the sibling occurrence, so a negated first hit is not judged alone', async () => {
    // The hazard: monitor_match keeps one row per (record, rule, field,
    // version) and it anchors on the FIRST occurrence - here the negated one.
    // Judging that sentence alone would return NEGATED+HIGH and filter a
    // report that documents an ulcer.
    const text = '十二指肠球部未见明显溃疡；胃窦见巨大溃疡，表面覆白苔。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'PRESENT',
        confidence: 'HIGH',
        evidence: '胃窦见巨大溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.context.text).toContain('未见明显溃疡');
    expect(result.context.text).toContain('胃窦见巨大溃疡');
    expect(result.decision.filtered).toBe(false);

    // And the prompt really carried both clauses to the model.
    expect(client.requests[0].user).toContain('胃窦见巨大溃疡');
  });

  it('does not send the whole report when only one sentence is relevant', async () => {
    const text = '食管黏膜光滑。胃窦见巨大溃疡。十二指肠球部未见异常。降部未见异常。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'PRESENT',
        confidence: 'HIGH',
        evidence: '胃窦见巨大溃疡',
      }),
    });

    const result = await validateMatch(
      inputFor(text, '溃疡'),
      deps(client, { contextCharBudget: 12 }),
    );

    expect(result.context.isWholeField).toBe(false);
    expect(result.context.text).toBe('胃窦见巨大溃疡。');
  });

  it('the context is always a verbatim slice of the field', async () => {
    const text = '第一句。第二句含溃疡一词。第三句。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'PRESENT',
        confidence: 'HIGH',
        evidence: '溃疡',
      }),
    });

    const input = inputFor(text, '溃疡');
    const result = await validateMatch(input, deps(client));

    expect(result.context.text).toBe(text.slice(result.context.start, result.context.end));
  });

  it('records the hash of the exact context sent, and a stable input hash', async () => {
    const text = '胃窦见溃疡。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'PRESENT',
        confidence: 'HIGH',
        evidence: '溃疡',
      }),
    });

    const first = await validateMatch(inputFor(text, '溃疡'), deps(client));
    const second = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(first.inputHash).toHaveLength(64);
    expect(first.contextHash).toBe(second.contextHash);
    // Identical input must hash identically, or the audit trail's
    // "which input produced this" claim is meaningless.
    expect(first.inputHash).toBe(second.inputHash);
  });
});

describe('validateMatch - verdict handling', () => {
  it('accepts a reply wrapped in a code fence', async () => {
    const text = '未见明显溃疡。';
    const body = reply({
      matched: false,
      semanticStatus: 'NEGATED',
      confidence: 'HIGH',
      evidence: '未见明显溃疡',
    });
    const client = new FakeModelClient({ kind: 'reply', raw: '```json\n' + body + '\n```' });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.outcome).toBe('OK');
    expect(result.decision.filtered).toBe(true);
  });

  it('bounds the reason and flattens newlines', async () => {
    const text = '未见明显溃疡。';
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: false,
        semanticStatus: 'NEGATED',
        confidence: 'HIGH',
        reason: '第一行\n第二行 ' + '很长的理由'.repeat(100),
        evidence: '未见明显溃疡',
      }),
    });

    const result = await validateMatch(inputFor(text, '溃疡'), deps(client));

    expect(result.verdict?.reason.length).toBeLessThanOrEqual(300);
    expect(result.verdict?.reason).not.toContain('\n');
  });

  it('reports the model version the gateway declared', async () => {
    const client = new FakeModelClient({
      kind: 'reply',
      raw: reply({
        matched: true,
        semanticStatus: 'PRESENT',
        confidence: 'HIGH',
        evidence: '溃疡',
      }),
      modelVersion: 'snapshot-2026-08',
    });

    const result = await validateMatch(inputFor('胃窦见溃疡。', '溃疡'), deps(client));

    expect(result.modelVersion).toBe('snapshot-2026-08');
    expect(result.taskVersion).toBe('validate-match/1');
  });
});
