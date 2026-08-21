import { normalizeForMatch, toComparisonCase } from './normalize';

describe('normalizeForMatch', () => {
  it('converts full-width punctuation to half-width while preserving string length', () => {
    const input = '诊断：贲门失弛缓症（考虑）。';
    const normalized = normalizeForMatch(input);
    expect(normalized.length).toBe(input.length);
    expect(normalized).toBe('诊断:贲门失弛缓症(考虑).');
  });

  it('converts full-width space to a regular space', () => {
    const input = '胃　息肉';
    const normalized = normalizeForMatch(input);
    expect(normalized.length).toBe(input.length);
    expect(normalized).toBe('胃 息肉');
  });

  it('leaves CJK ideographs and half-width text unchanged', () => {
    const input = '胃息肉,建议随访 ca';
    expect(normalizeForMatch(input)).toBe(input);
  });

  it('is index-preserving: normalized[i] corresponds to original[i] for every i', () => {
    const input = '（Ａ）ｃａ！';
    const normalized = normalizeForMatch(input);
    expect(normalized.length).toBe(input.length);
    expect(normalized).toBe('(A)ca!');
  });
});

describe('toComparisonCase', () => {
  it('lowercases when caseSensitive is false', () => {
    expect(toComparisonCase('CA', false)).toBe('ca');
  });

  it('leaves text unchanged when caseSensitive is true', () => {
    expect(toComparisonCase('CA', true)).toBe('CA');
  });
});
