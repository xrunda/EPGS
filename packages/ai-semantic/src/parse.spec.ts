import { SemanticError } from './errors';
import { extractJsonObject, parseValidateMatchVerdict } from './parse';
import { canonicalJson, sha256Hex } from './hashing';

/**
 * Structured-output validation. The tolerance under test is about the
 * ENVELOPE (fences, prose, trailing explanation); content is validated
 * strictly, because a guessed verdict would look like a judgement.
 */

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    matched: false,
    semantic_status: 'NEGATED',
    confidence: 'HIGH',
    reason: '未见',
    evidence: '未见明显溃疡',
    intent_excludes_history: false,
    ...overrides,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SemanticError);
    expect((err as SemanticError).code).toBe(code);
    return;
  }
  throw new Error(`expected a SemanticError with code ${code}, but nothing was thrown`);
}

describe('extractJsonObject', () => {
  it('returns the object from a bare reply', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('ignores a code fence and surrounding prose', () => {
    expect(extractJsonObject('好的，结果如下：\n```json\n{"a":1}\n```\n以上。')).toBe('{"a":1}');
  });

  it('stops at the matching brace, not the last one', () => {
    // A trailing explanation containing braces must not be swallowed.
    expect(extractJsonObject('{"a":1} 说明：{这不在对象内}')).toBe('{"a":1}');
  });

  it('ignores braces inside string values', () => {
    expect(extractJsonObject('{"a":"}"}')).toBe('{"a":"}"}');
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject('{"a":"say \\"hi\\" }"}')).toBe('{"a":"say \\"hi\\" }"}');
  });

  it('returns null for text with no object', () => {
    expect(extractJsonObject('我无法完成该请求。')).toBeNull();
  });

  it('returns null for an object that never closes', () => {
    // Truncated output - most likely maxTokens hit mid-object.
    expect(extractJsonObject('{"matched": false, "semantic_status": "NEG')).toBeNull();
  });
});

describe('parseValidateMatchVerdict', () => {
  it('parses a well-formed reply', () => {
    const verdict = parseValidateMatchVerdict(body());
    expect(verdict).toEqual({
      matched: false,
      semanticStatus: 'NEGATED',
      confidence: 'HIGH',
      reason: '未见',
      evidence: '未见明显溃疡',
      intentExcludesHistory: false,
    });
  });

  it('parses a fenced reply', () => {
    expect(parseValidateMatchVerdict('```json\n' + body() + '\n```').semanticStatus).toBe(
      'NEGATED',
    );
  });

  it('maps the snake_case wire fields to camelCase', () => {
    const verdict = parseValidateMatchVerdict(
      body({ semantic_status: 'HISTORY', intent_excludes_history: true, matched: false }),
    );
    expect(verdict.semanticStatus).toBe('HISTORY');
    expect(verdict.intentExcludesHistory).toBe(true);
  });

  it.each([
    ['no JSON at all', '抱歉。', 'INVALID_JSON'],
    ['malformed JSON', '{"a": }', 'INVALID_JSON'],
    ['a JSON array', '[1,2]', 'INVALID_JSON'],
    ['a JSON scalar', '"hello"', 'INVALID_JSON'],
  ])('rejects %s', (_label, raw, code) => {
    expectCode(() => parseValidateMatchVerdict(raw), code);
  });

  it.each([
    ['matched', { matched: undefined }],
    ['semantic_status', { semantic_status: undefined }],
    ['confidence', { confidence: undefined }],
    ['reason', { reason: undefined }],
    ['evidence', { evidence: undefined }],
    ['intent_excludes_history', { intent_excludes_history: undefined }],
  ])('rejects a reply missing %s', (_label, override) => {
    expectCode(() => parseValidateMatchVerdict(body(override)), 'SCHEMA_INVALID');
  });

  it.each([
    ['matched as a string', { matched: 'false' }],
    ['confidence as a number', { confidence: 1 }],
    ['reason as an object', { reason: {} }],
    ['evidence as null', { evidence: null }],
  ])('rejects %s', (_label, override) => {
    expectCode(() => parseValidateMatchVerdict(body(override)), 'SCHEMA_INVALID');
  });

  it.each([
    ['semantic_status', { semantic_status: 'PROBABLY' }, 'UNKNOWN_ENUM'],
    ['confidence', { confidence: 'CERTAIN' }, 'UNKNOWN_ENUM'],
    ['a lowercase status', { semantic_status: 'negated' }, 'UNKNOWN_ENUM'],
  ])('reports %s as an unknown enum, distinctly from a schema error', (_label, override, code) => {
    // Worth separating: a wrong TYPE is usually a broken gateway, while an
    // invented VALUE is usually the model - a prompt signal, not a transport
    // one, so it has to be countable on its own.
    expectCode(() => parseValidateMatchVerdict(body(override)), code);
  });

  it('bounds and flattens the reason', () => {
    const verdict = parseValidateMatchVerdict(body({ reason: 'a\n'.repeat(500) }));
    expect(verdict.reason.length).toBeLessThanOrEqual(300);
    expect(verdict.reason).not.toContain('\n');
  });

  it('accepts an empty reason rather than failing the judgement over cosmetics', () => {
    expect(parseValidateMatchVerdict(body({ reason: '' })).reason).toBe('');
  });

  it('keeps the evidence unmodified so verification sees what the model sent', () => {
    const verdict = parseValidateMatchVerdict(body({ evidence: '  未见明显溃疡  ' }));
    expect(verdict.evidence).toBe('  未见明显溃疡  ');
  });
});

describe('canonicalJson / sha256Hex', () => {
  it('produces the same hash regardless of key insertion order', () => {
    // The property inputHash depends on: without it, a refactor that reorders
    // an object literal would silently change every hash.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(sha256Hex(canonicalJson({ b: 1, a: 2 }))).toBe(sha256Hex(canonicalJson({ a: 2, b: 1 })));
  });

  it('sorts keys at every depth', () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined so an absent optional field hashes the same as an explicit undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('yields 64 hex characters', () => {
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
