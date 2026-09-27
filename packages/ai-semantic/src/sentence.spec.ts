import { sentenceIndexAt, splitSentences } from './sentence';

describe('splitSentences', () => {
  it('returns [] for empty text', () => {
    expect(splitSentences('')).toEqual([]);
  });

  it('splits on Chinese full stops, keeping the terminator', () => {
    const text = '第一句。第二句。第三句';
    expect(splitSentences(text)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 11 },
    ]);
  });

  it('treats the semicolons endoscopy findings are written with as boundaries', () => {
    const text = '十二指肠球部未见明显溃疡；胃窦见巨大溃疡。';
    const spans = splitSentences(text);
    expect(spans).toHaveLength(2);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('十二指肠球部未见明显溃疡；');
    expect(text.slice(spans[1].start, spans[1].end)).toBe('胃窦见巨大溃疡。');
  });

  it('treats a newline as a boundary', () => {
    const text = '检查所见：\n胃窦见溃疡。';
    const spans = splitSentences(text);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('检查所见：\n');
  });

  it('does not split a decimal measurement', () => {
    const text = '溃疡大小约 1.5cm，周围充血。';
    const spans = splitSentences(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(text);
  });

  it('absorbs a CRLF into the preceding sentence', () => {
    const text = '第一句。\r\n第二句。';
    const spans = splitSentences(text);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('第一句。\r\n');
    expect(spans).toHaveLength(2);
  });

  it('produces contiguous spans that cover the whole text', () => {
    const text = '甲。乙！丙？丁；戊\n己';
    const spans = splitSentences(text);
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(text.length);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start).toBe(spans[i - 1].end);
    }
  });
});

describe('sentenceIndexAt', () => {
  const text = '第一句。第二句。第三句。';
  const spans = splitSentences(text);

  it('returns -1 for no spans', () => {
    expect(sentenceIndexAt([], 0)).toBe(-1);
  });

  it('finds the containing sentence', () => {
    expect(sentenceIndexAt(spans, 0)).toBe(0);
    expect(sentenceIndexAt(spans, 2)).toBe(0);
    expect(sentenceIndexAt(spans, 5)).toBe(1);
    expect(sentenceIndexAt(spans, 9)).toBe(2);
  });

  it('attributes an offset exactly on a boundary to the later sentence', () => {
    // The hit that begins right after a terminator belongs to the sentence it
    // starts, not the one that just ended.
    expect(sentenceIndexAt(spans, 4)).toBe(1);
    expect(sentenceIndexAt(spans, 8)).toBe(2);
  });

  it('clamps out-of-range offsets instead of throwing', () => {
    expect(sentenceIndexAt(spans, -10)).toBe(0);
    expect(sentenceIndexAt(spans, 9999)).toBe(spans.length - 1);
  });
});
