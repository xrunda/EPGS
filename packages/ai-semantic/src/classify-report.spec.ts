import { classifyReport, computeAttentionLevel, ClassifyReportDeps } from './classify-report';
import { parseClassifyReportVerdict } from './classify-parse';
import { SemanticError } from './errors';
import type {
  SemanticModelClient,
  SemanticModelRequest,
  SemanticModelResponse,
} from './model-client';
import {
  AttentionSemanticSnapshot,
  ClassifyReportInput,
  CLASSIFY_REPORT_PROMPT_VERSION,
} from './classify-types';

/**
 * Classify Report end to end, with a fake model (issue #88).
 *
 * No test here needs a real model, a network or a container: the
 * `SemanticModelClient` seam is what makes issue #88's acceptance list offline
 * and deterministic. Samples use real Chinese endoscopy phrasing so the
 * evidence verification runs against the shapes that actually occur.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE: they prove the CODE contract - every
 * match kept, level taken as the maximum, evidence grounded or the attempt
 * rejected, failures isolated. They cannot prove the model's MEDICAL judgement
 * (issue #88 §14's headline case, "no keyword, but the combination of findings
 * means something") - a fake model returns whatever it is told. That case is
 * covered by the pre-launch replay against doctor-annotated real reports, which
 * is a separate gate and is not replaced by anything here.
 */

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

const RED_SEMANTIC: AttentionSemanticSnapshot = {
  id: '11111111-1111-1111-1111-111111111111',
  version: 3,
  attentionLevel: 'RED',
  name: '高度疑似恶性病变',
  description: '本次内镜检查发现明确或高度疑似的重要恶性、占位或浸润性病变，需要优先关注。',
};

const YELLOW_SEMANTIC: AttentionSemanticSnapshot = {
  id: '22222222-2222-2222-2222-222222222222',
  version: 1,
  attentionLevel: 'YELLOW',
  name: '性质待定的占位性病变',
  description: '本次内镜检查发现占位性病变，性质尚不明确，需要进一步关注。',
};

const GREEN_SEMANTIC: AttentionSemanticSnapshot = {
  id: '33333333-3333-3333-3333-333333333333',
  version: 2,
  attentionLevel: 'GREEN',
  name: '一般性异常发现',
  description: '本次内镜检查存在一般性异常或常规关注发现。',
};

/** The report every test starts from unless it says otherwise. */
const REPORT: ClassifyReportInput = {
  examItem: '电子胃镜检查',
  reportContent: '胃体见巨大不规则隆起，表面糜烂，质脆，触之易出血。',
  diagnosis: '胃体占位性病变，性质待定。',
  semantics: [RED_SEMANTIC, YELLOW_SEMANTIC, GREEN_SEMANTIC],
};

function depsWith(behaviour: ConstructorParameters<typeof FakeModelClient>[0]): {
  deps: ClassifyReportDeps;
  client: FakeModelClient;
} {
  const client = new FakeModelClient(behaviour);
  return { deps: { client, model: 'hospital-gateway-model' }, client };
}

function reply(level: string, matches: unknown[]): string {
  return JSON.stringify({ attention_level: level, matches });
}

/** A well-formed match for one of the fixture semantics. */
function matchFor(
  semanticId: string,
  evidence: string[],
  confidence = 'HIGH',
  reason = '报告整体表现符合该关注语义',
): Record<string, unknown> {
  return { semantic_id: semanticId, reason, evidence, confidence };
}

describe('classifyReport', () => {
  it('accepts a single red match that the keyword path could not have found', async () => {
    // Issue #88 §14: the report never says 癌/肿瘤; it describes a combination
    // of findings. The pipeline's job is to carry that verdict through intact.
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('RED', [
        matchFor(RED_SEMANTIC.id, ['胃体见巨大不规则隆起，表面糜烂，质脆，触之易出血']),
      ]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('OK');
    expect(result.error).toBeNull();
    expect(result.attentionLevel).toBe('RED');
    expect(result.modelAttentionLevel).toBe('RED');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].attentionLevel).toBe('RED');
    expect(result.matches[0].semanticVersion).toBe(RED_SEMANTIC.version);
    expect(result.matches[0].evidence).toHaveLength(1);
    expect(result.matches[0].evidence[0].field).toBe('FINDINGS');
  });

  it('keeps every match when red and yellow both apply, and reports RED', async () => {
    // Issue #88 §8.2/§8.3: ALL matches are saved; a red hit must not drop the
    // yellow one.
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('RED', [
        matchFor(RED_SEMANTIC.id, ['胃体见巨大不规则隆起']),
        matchFor(YELLOW_SEMANTIC.id, ['性质待定'], 'MEDIUM'),
      ]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('OK');
    expect(result.attentionLevel).toBe('RED');
    expect(result.matches.map((m) => m.semanticId).sort()).toEqual(
      [RED_SEMANTIC.id, YELLOW_SEMANTIC.id].sort(),
    );
    // The yellow match survives with its own configured level, not the report's.
    expect(result.matches.find((m) => m.semanticId === YELLOW_SEMANTIC.id)?.attentionLevel).toBe(
      'YELLOW',
    );
  });

  it('is order-independent: the same matches in a different order give the same level', async () => {
    const forward = depsWith({
      kind: 'reply',
      raw: reply('RED', [
        matchFor(RED_SEMANTIC.id, ['胃体见巨大不规则隆起']),
        matchFor(YELLOW_SEMANTIC.id, ['性质待定']),
      ]),
    });
    const reversed = depsWith({
      kind: 'reply',
      raw: reply('RED', [
        matchFor(YELLOW_SEMANTIC.id, ['性质待定']),
        matchFor(RED_SEMANTIC.id, ['胃体见巨大不规则隆起']),
      ]),
    });

    const a = await classifyReport(REPORT, forward.deps);
    const b = await classifyReport(REPORT, reversed.deps);

    expect(a.attentionLevel).toBe('RED');
    expect(b.attentionLevel).toBe('RED');
    expect(new Set(a.matches.map((m) => m.semanticId))).toEqual(
      new Set(b.matches.map((m) => m.semanticId)),
    );
  });

  it('treats a genuine no-match reply as OK/NONE, not as a failure', async () => {
    // Issue #88 §14: "未见明显占位及恶性征象" must not match a semantic merely
    // because the words 占位/恶性 appear. Here that is the model's job; the
    // CODE's job - and what this asserts - is that an honest empty answer is
    // recorded as a real negative rather than confused with a failure.
    const { deps } = depsWith({ kind: 'reply', raw: reply('NONE', []) });

    const result = await classifyReport(
      { ...REPORT, reportContent: '未见明显占位及恶性征象，黏膜光滑。', diagnosis: null },
      deps,
    );

    expect(result.outcome).toBe('OK');
    expect(result.error).toBeNull();
    expect(result.attentionLevel).toBeNull();
    expect(result.modelAttentionLevel).toBe('NONE');
    expect(result.matches).toEqual([]);
  });

  it('rejects an attempt whose level contradicts its own matches', async () => {
    // The model claims NONE while listing a red semantic. The code computed
    // RED, so the attempt is rejected outright - the model cannot set a level.
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('NONE', [matchFor(RED_SEMANTIC.id, ['胃体见巨大不规则隆起'])]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('INCOHERENT_LEVEL');
    expect(result.matches).toEqual([]);
    expect(result.attentionLevel).toBeNull();
  });

  it('rejects an attempt that claims a higher level than its matches support', async () => {
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('RED', [matchFor(YELLOW_SEMANTIC.id, ['性质待定'])]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('INCOHERENT_LEVEL');
  });

  it('rejects forged evidence and keeps nothing from the attempt', async () => {
    // Issue #88 §14 last row / §9: evidence the model invented must not become a
    // finding.
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('RED', [matchFor(RED_SEMANTIC.id, ['胃体见巨大溃疡伴活动性出血'])]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('EVIDENCE_UNVERIFIED');
    expect(result.matches).toEqual([]);
  });

  it('discards the WHOLE attempt when one match is grounded and another is not', async () => {
    // The strict contract (owner decision): dropping only the bad match would
    // compute the level from an incomplete set and could come out LOWER than
    // what the model claimed - a silent under-report.
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('RED', [
        matchFor(RED_SEMANTIC.id, ['这段话在报告里根本不存在']),
        matchFor(YELLOW_SEMANTIC.id, ['性质待定']),
      ]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('EVIDENCE_UNVERIFIED');
    expect(result.matches).toEqual([]);
    expect(result.attentionLevel).toBeNull();
  });

  it('rejects a semantic_id the hospital never configured', async () => {
    // Issue #88 §9: this fails the whole attempt, not just the unknown match.
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('RED', [matchFor('99999999-9999-9999-9999-999999999999', ['性质待定'])]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('UNKNOWN_SEMANTIC');
    expect(result.matches).toEqual([]);
  });

  it('locates evidence in whichever report field it actually came from', async () => {
    const { deps } = depsWith({
      kind: 'reply',
      raw: reply('YELLOW', [matchFor(YELLOW_SEMANTIC.id, ['胃体占位性病变，性质待定'])]),
    });

    const result = await classifyReport(REPORT, deps);

    expect(result.outcome).toBe('OK');
    expect(result.matches[0].evidence[0].field).toBe('IMPRESSION');
  });

  it('does not call the model at all when every report field is empty', async () => {
    const { deps, client } = depsWith({ kind: 'reply', raw: reply('NONE', []) });

    const result = await classifyReport(
      { examItem: null, reportContent: '   ', diagnosis: undefined, semantics: [RED_SEMANTIC] },
      deps,
    );

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('EMPTY_INPUT');
    expect(client.requests).toHaveLength(0);
  });

  it('does not call the model when the hospital has no enabled semantics', async () => {
    const { deps, client } = depsWith({ kind: 'reply', raw: reply('NONE', []) });

    const result = await classifyReport({ ...REPORT, semantics: [] }, deps);

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('NO_SEMANTICS');
    expect(client.requests).toHaveLength(0);
  });

  it('skips an over-long report instead of truncating it', async () => {
    const { deps, client } = depsWith({ kind: 'reply', raw: reply('NONE', []) });

    const result = await classifyReport(
      { ...REPORT, reportContent: '黏'.repeat(50) },
      { ...deps, reportMaxChars: 10 },
    );

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toBe('REPORT_TOO_LONG');
    expect(client.requests).toHaveLength(0);
  });

  describe('failure isolation (issue #88 §11)', () => {
    it('reports a timeout as a failed attempt, never as a finding', async () => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const { deps } = depsWith({ kind: 'throw', error: abort });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('ERROR');
      expect(result.error).toBe('TIMEOUT');
      expect(result.matches).toEqual([]);
      expect(result.attentionLevel).toBeNull();
    });

    it('reports a transport failure as NETWORK', async () => {
      const { deps } = depsWith({ kind: 'throw', error: new TypeError('fetch failed') });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('ERROR');
      expect(result.error).toBe('NETWORK');
    });

    it('reports an HTTP failure with its status, never a body', async () => {
      const { deps } = depsWith({
        kind: 'throw',
        error: new SemanticError('HTTP_503', 'gateway returned 503'),
      });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('ERROR');
      expect(result.error).toBe('HTTP_503');
    });

    it('rejects a reply that is not JSON at all', async () => {
      const { deps } = depsWith({ kind: 'reply', raw: '抱歉，我无法完成这个请求。' });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('ERROR');
      expect(result.error).toBe('INVALID_JSON');
    });

    it('rejects an unknown attention_level value', async () => {
      const { deps } = depsWith({ kind: 'reply', raw: reply('CRITICAL', []) });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('ERROR');
      expect(result.error).toBe('UNKNOWN_ENUM');
    });

    it('rejects a match that carries no evidence', async () => {
      const { deps } = depsWith({
        kind: 'reply',
        raw: reply('RED', [{ semantic_id: RED_SEMANTIC.id, reason: 'x', evidence: [], confidence: 'HIGH' }]),
      });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('ERROR');
      expect(result.error).toBe('SCHEMA_INVALID');
    });

    it('rejects an over-long evidence excerpt', async () => {
      const { deps } = depsWith({
        kind: 'reply',
        raw: reply('RED', [matchFor(RED_SEMANTIC.id, ['胃'.repeat(600)])]),
      });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('ERROR');
      expect(result.error).toBe('SCHEMA_INVALID');
    });

    it('carries nothing but hashes and offsets out of a failed attempt', async () => {
      // The result is what gets persisted, so this is the boundary that decides
      // whether report text can reach a column that must not hold it. Every
      // string here is an id, a version, a machine code or a hash - asserted by
      // shape, since a string search would only prove it about today's sample.
      const { deps } = depsWith({
        kind: 'reply',
        raw: reply('RED', [matchFor(RED_SEMANTIC.id, ['胃体见巨大不规则隆起'])]),
      });

      const result = await classifyReport(REPORT, deps);

      expect(result.outcome).toBe('OK');
      const persisted = [
        result.task,
        result.taskVersion,
        result.model,
        result.modelVersion,
        result.error,
        result.inputHash,
        result.reportHash,
        result.configHash,
        ...result.matches.flatMap((match) => [
          match.semanticId,
          match.semanticName,
          match.reason,
          match.confidence,
          ...match.evidence.flatMap((e) => [e.field, e.hash]),
        ]),
      ];
      for (const value of persisted) {
        if (value === null) continue;
        expect(value).not.toContain(REPORT.reportContent);
        expect(value).not.toContain(REPORT.diagnosis as string);
      }
      // The offsets DO point into the report - that is their job, and it is the
      // only way back to the text, which stays in monitor_record where it was
      // already stored and already access-controlled.
      const [first] = result.matches[0].evidence;
      expect(REPORT.reportContent?.slice(first.start, first.end)).toBe('胃体见巨大不规则隆起');
    });
  });

  describe('audit hashes', () => {
    it('is stable for the same input, and ignores the order semantics were passed in', async () => {
      const behaviour = {
        kind: 'reply' as const,
        raw: reply('NONE', []),
      };
      const first = await classifyReport(REPORT, depsWith(behaviour).deps);
      const second = await classifyReport(
        { ...REPORT, semantics: [...REPORT.semantics].reverse() },
        depsWith(behaviour).deps,
      );

      expect(first.inputHash).toBe(second.inputHash);
      expect(first.reportHash).toBe(second.reportHash);
      expect(first.configHash).toBe(second.configHash);
    });

    it('changes configHash when a semantic version changes, and reportHash when the text does', async () => {
      const behaviour = { kind: 'reply' as const, raw: reply('NONE', []) };
      const baseline = await classifyReport(REPORT, depsWith(behaviour).deps);

      const edited = await classifyReport(
        {
          ...REPORT,
          semantics: [{ ...RED_SEMANTIC, version: RED_SEMANTIC.version + 1 }, YELLOW_SEMANTIC, GREEN_SEMANTIC],
        },
        depsWith(behaviour).deps,
      );
      const retyped = await classifyReport(
        { ...REPORT, reportContent: `${REPORT.reportContent} 幽门螺杆菌阳性。` },
        depsWith(behaviour).deps,
      );

      expect(edited.reportHash).toBe(baseline.reportHash);
      expect(edited.configHash).not.toBe(baseline.configHash);
      expect(edited.inputHash).not.toBe(baseline.inputHash);

      expect(retyped.reportHash).not.toBe(baseline.reportHash);
      expect(retyped.configHash).toBe(baseline.configHash);
    });

    it('records the prompt/contract version on every attempt', async () => {
      const { deps } = depsWith({ kind: 'reply', raw: reply('NONE', []) });

      const result = await classifyReport(REPORT, deps);

      expect(result.task).toBe('CLASSIFY_REPORT');
      expect(result.taskVersion).toBe(CLASSIFY_REPORT_PROMPT_VERSION);
    });
  });

  it('sends only the report text and the configured semantics, and delimits both', async () => {
    const { deps, client } = depsWith({ kind: 'reply', raw: reply('NONE', []) });

    await classifyReport(REPORT, deps);

    const prompt = client.requests[0].user;
    expect(prompt).toContain('<<<报告原文开始>>>');
    expect(prompt).toContain('<<<关注语义开始>>>');
    expect(prompt).toContain(RED_SEMANTIC.id);
    // The keyword path must not be visible: the model has to reach its own
    // conclusion, or it could never find what the keyword rules missed.
    expect(prompt).not.toContain('关键词');
    // Patient identity is never sent.
    expect(prompt).not.toContain('患者');
  });
});

describe('computeAttentionLevel', () => {
  it('reduces configured levels by RED > YELLOW > GREEN', () => {
    expect(computeAttentionLevel([{ attentionLevel: 'GREEN' }, { attentionLevel: 'RED' }])).toBe('RED');
    expect(computeAttentionLevel([{ attentionLevel: 'GREEN' }, { attentionLevel: 'YELLOW' }])).toBe('YELLOW');
    expect(computeAttentionLevel([{ attentionLevel: 'GREEN' }])).toBe('GREEN');
  });

  it('is null - not UNCLASSIFIED, not NONE - when nothing matched', () => {
    expect(computeAttentionLevel([])).toBeNull();
  });
});

describe('parseClassifyReportVerdict', () => {
  it('tolerates a fenced or narrated envelope', () => {
    const raw = '好的，以下是判断结果：\n```json\n{"attention_level":"NONE","matches":[]}\n```';
    expect(parseClassifyReportVerdict(raw)).toEqual({ attentionLevel: 'NONE', matches: [] });
  });

  it('rejects the same semantic_id listed twice', () => {
    const raw = reply('RED', [
      matchFor('aaaaaaaa-0000-0000-0000-000000000000', ['性质待定']),
      matchFor('aaaaaaaa-0000-0000-0000-000000000000', ['胃体见巨大不规则隆起']),
    ]);
    expect(() => parseClassifyReportVerdict(raw)).toThrow(SemanticError);
  });

  it('bounds and flattens the reason', () => {
    const raw = reply('NONE', []);
    expect(parseClassifyReportVerdict(raw).matches).toEqual([]);

    const withReason = reply('YELLOW', [
      matchFor(YELLOW_SEMANTIC.id, ['性质待定'], 'LOW', `  第一行\n第二行   `),
    ]);
    const parsed = parseClassifyReportVerdict(withReason);
    expect(parsed.matches[0].reason).toBe('第一行 第二行');
  });
});
