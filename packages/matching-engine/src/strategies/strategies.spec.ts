import { normalizeForMatch } from '../normalize';
import { buildRule } from '../test-fixtures';
import { ContainsStrategy } from './contains-strategy';
import { ExactStrategy } from './exact-strategy';
import { RegexStrategy } from './regex-strategy';

function run(
  strategy: {
    findOccurrences: (
      o: string,
      n: string,
      r: ReturnType<typeof buildRule>,
    ) => { start: number; end: number }[];
  },
  text: string,
  rule: ReturnType<typeof buildRule>,
) {
  return strategy.findOccurrences(text, normalizeForMatch(text), rule);
}

describe('ContainsStrategy', () => {
  const strategy = new ContainsStrategy();

  it('finds every substring occurrence, including overlapping repeats', () => {
    const rule = buildRule({ ruleId: 'r1', keyword: 'aa', level: 'GREEN' });
    const hits = run(strategy, 'aaa', rule);
    // "aaa" contains "aa" at index 0 and index 1 (overlapping) - both counted.
    expect(hits).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ]);
  });

  it('returns no hits for an empty keyword', () => {
    const rule = buildRule({ ruleId: 'r1', keyword: '', level: 'GREEN' });
    expect(run(strategy, '任意文本', rule)).toEqual([]);
  });
});

describe('ExactStrategy', () => {
  const strategy = new ExactStrategy();

  it('matches a keyword bounded by punctuation/whitespace', () => {
    const rule = buildRule({
      ruleId: 'r1',
      keyword: '胃溃疡',
      level: 'YELLOW',
      matchMode: 'EXACT',
    });
    const hits = run(strategy, '诊断：胃溃疡。', rule);
    expect(hits).toEqual([{ start: 3, end: 6 }]);
  });

  it('does not match when the keyword is only a sub-phrase glued to more word characters on a side', () => {
    const rule = buildRule({ ruleId: 'r1', keyword: '溃疡', level: 'YELLOW', matchMode: 'EXACT' });
    // "胃溃疡病灶" - "溃疡" is directly preceded by "胃" and followed by "病", not boundary chars.
    const hits = run(strategy, '胃溃疡病灶', rule);
    expect(hits).toEqual([]);
  });

  it('matches at string start/end (implicit boundaries)', () => {
    const rule = buildRule({ ruleId: 'r1', keyword: '息肉', level: 'GREEN', matchMode: 'EXACT' });
    const hits = run(strategy, '息肉', rule);
    expect(hits).toEqual([{ start: 0, end: 2 }]);
  });
});

describe('RegexStrategy', () => {
  const strategy = new RegexStrategy();

  it('finds all regex matches', () => {
    const rule = buildRule({ ruleId: 'r1', keyword: 'ca|癌', level: 'RED', matchMode: 'REGEX' });
    const hits = run(strategy, '考虑胃癌可能，ca确诊', rule);
    expect(hits.length).toBe(2);
  });

  it('returns no hits and does not throw for an invalid pattern', () => {
    const rule = buildRule({
      ruleId: 'r1',
      keyword: '(unterminated',
      level: 'RED',
      matchMode: 'REGEX',
    });
    expect(() => run(strategy, '任意文本', rule)).not.toThrow();
    expect(run(strategy, '任意文本', rule)).toEqual([]);
  });

  it('does not infinite-loop on a zero-length-match pattern', () => {
    const rule = buildRule({ ruleId: 'r1', keyword: 'x*', level: 'RED', matchMode: 'REGEX' });
    expect(() => run(strategy, 'abc', rule)).not.toThrow();
  });
});
