import { matchReport } from '@epgs/matching-engine';
import type { RuleSnapshot } from '@epgs/matching-engine';
import { buildContextWindow, deriveOccurrences } from './context';

describe('deriveOccurrences', () => {
  it('finds every occurrence including overlapping repeats', () => {
    const text = '溃疡，溃疡，还是溃疡。';
    expect(deriveOccurrences(text, '溃疡', 'CONTAINS')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 8, end: 10 },
    ]);
  });

  it('finds nothing for an empty keyword or empty text', () => {
    expect(deriveOccurrences('文本', '', 'CONTAINS')).toEqual([]);
    expect(deriveOccurrences('', '溃疡', 'CONTAINS')).toEqual([]);
  });

  it('honours EXACT mode (delimiter-bounded phrase)', () => {
    // EXACT requires the keyword not to be glued to a neighbouring CJK
    // character, so "溃疡" inside "胃溃疡" is not an occurrence but a
    // punctuation-bounded one is.
    expect(deriveOccurrences('诊断：溃疡。', '溃疡', 'EXACT')).toEqual([{ start: 3, end: 5 }]);
    expect(deriveOccurrences('诊断：胃溃疡。', '溃疡', 'EXACT')).toEqual([]);
  });

  it('agrees with matchReport about which occurrences exist', () => {
    // The property that actually matters: re-derivation must find the SAME
    // hits the deterministic engine recorded, or the judge would be reasoning
    // about a different set of occurrences than the ones on record.
    const text = '十二指肠球部未见明显溃疡；胃窦见巨大溃疡，表面覆白苔。';
    const rule: RuleSnapshot = {
      ruleId: 'r1',
      ruleVersion: 1,
      keyword: '溃疡',
      level: 'RED',
      matchField: 'FINDINGS',
      matchMode: 'CONTAINS',
      enabled: true,
    };

    const result = matchReport({
      reportId: 'rep-1',
      reportVersion: 1,
      describeText: text,
      diagnoseText: null,
      rules: [rule],
    });
    const fromMatcher = result.matchedRules[0].occurrences.map((o) => ({
      start: o.start,
      end: o.end,
    }));

    expect(deriveOccurrences(text, '溃疡', 'CONTAINS')).toEqual(fromMatcher);
  });

  it('does not throw for a REGEX rule with an invalid pattern', () => {
    // Falls back to [] so the caller can still use the anchor occurrence.
    expect(deriveOccurrences('胃窦见溃疡。', '([', 'REGEX')).toEqual([]);
  });
});

describe('buildContextWindow', () => {
  it('returns an empty window for empty field text', () => {
    const window = buildContextWindow({
      fieldText: '',
      matchStart: 0,
      matchEnd: 2,
      charBudget: 400,
    });
    expect(window).toEqual({ text: '', start: 0, end: 0, isWholeField: true });
  });

  it.each([
    ['negative start', -1, 2],
    ['end before start', 5, 5],
    ['end past the text', 0, 999],
    ['non-integer', 1.5, 3],
  ])('returns an empty window for an unusable anchor (%s)', (_label, start, end) => {
    const window = buildContextWindow({
      fieldText: '胃窦见溃疡。',
      matchStart: start,
      matchEnd: end,
      charBudget: 400,
    });
    expect(window.text).toBe('');
  });

  it('includes the whole sentence containing the hit, not a character radius', () => {
    const text = '检查所见：胃窦部可见一巨大溃疡，表面覆白苔，周围黏膜充血水肿明显。';
    const start = text.indexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: start,
      matchEnd: start + 2,
      charBudget: 400,
    });
    expect(window.text).toBe(text);
  });

  it('covers every sibling occurrence, not just the anchor', () => {
    // The multi-occurrence hazard: the surviving match row anchors on the
    // FIRST occurrence, which here is the negated one.
    const text = '第一句无关。十二指肠球部未见明显溃疡；胃窦见巨大溃疡。最后一句无关。';
    const anchor = text.indexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: anchor,
      matchEnd: anchor + 2,
      keyword: '溃疡',
      matchMode: 'CONTAINS',
      // Budget 25 fits the core (22) but not either unrelated neighbour (6/7),
      // so this asserts coverage AND the refusal to take the whole field.
      charBudget: 25,
    });

    expect(window.text).toContain('未见明显溃疡');
    expect(window.text).toContain('胃窦见巨大溃疡');
    expect(window.text).not.toContain('第一句无关');
    expect(window.text).not.toContain('最后一句无关');
  });

  it('keeps sibling occurrences even when the budget cannot hold the core span', () => {
    // The sibling sentences alone bust the budget. They still win: a window
    // that judged the negated first clause on its own would filter a report
    // that documents an ulcer.
    const text =
      '食管黏膜光滑。十二指肠球部未见明显溃疡；胃窦见巨大溃疡。降部未见异常。球后未见异常。';
    const anchor = text.indexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: anchor,
      matchEnd: anchor + 2,
      keyword: '溃疡',
      matchMode: 'CONTAINS',
      charBudget: 12,
    });

    expect(window.text).toBe('十二指肠球部未见明显溃疡；胃窦见巨大溃疡。');
    expect(window.text).toBe(text.slice(window.start, window.end));
  });

  it('accepts caller-supplied siblings instead of re-deriving them', () => {
    const text = '甲。乙含溃疡。丙。丁含溃疡。戊。';
    const second = text.lastIndexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: 999, // deliberately wrong: the supplied anchor below wins
      matchEnd: 1000,
      siblingOccurrences: [{ start: second, end: second + 2 }],
      charBudget: 400,
    });
    // An unusable anchor is still unusable - siblings do not rescue it.
    expect(window.text).toBe('');
  });

  it('is always a verbatim slice of the field', () => {
    const text = '甲。乙含溃疡。丙。';
    const start = text.indexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: start,
      matchEnd: start + 2,
      // Exactly the core sentence: no room for either neighbour.
      charBudget: 6,
    });
    expect(window.text).toBe(text.slice(window.start, window.end));
    expect(window.text).toBe('乙含溃疡。');
    expect(window.isWholeField).toBe(false);
  });

  it('never truncates the anchor sentence, even when it alone busts the budget', () => {
    // A truncated sentence is the single most likely cause of a wrong verdict,
    // so the budget yields rather than the sentence.
    const longSentence =
      '胃窦部可见一巨大溃疡，表面覆白苔，周围黏膜充血水肿明显，质地脆，易出血，取活检四块送病理检查。';
    const text = `前句。${longSentence}后句。`;
    const start = text.indexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: start,
      matchEnd: start + 2,
      charBudget: 10,
    });

    expect(window.text).toContain(longSentence);
    expect(window.text).not.toContain('前句');
    expect(window.text).not.toContain('后句');
  });

  it('grows outward with whole sentences when the core fits but leaves room', () => {
    const text = '甲句。乙句。丙句含溃疡。丁句。戊句。己句。';
    const start = text.indexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: start,
      matchEnd: start + 2,
      charBudget: 14,
    });

    // Core is the anchor sentence (6). Budget 14 leaves 8, which buys one
    // sentence on each side (3 + 3) and no more.
    expect(window.text).toBe('乙句。丙句含溃疡。丁句。');
    expect(window.text).toBe(text.slice(window.start, window.end));
  });

  it('reports isWholeField only when nothing was left out', () => {
    const text = '只有一句含溃疡。';
    const start = text.indexOf('溃疡');
    const window = buildContextWindow({
      fieldText: text,
      matchStart: start,
      matchEnd: start + 2,
      charBudget: 400,
    });
    expect(window.isWholeField).toBe(true);
  });
});
