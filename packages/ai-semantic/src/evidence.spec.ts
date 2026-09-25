import { verifyEvidence } from './evidence';
import { sha256Hex } from './hashing';

/**
 * Evidence verification. The security-relevant property under test is
 * one-sided: a failure must never look like a success, because a verified
 * "success" is what unlocks the rest of the pipeline.
 */

const CONTEXT = '十二指肠球部未见明显溃疡，黏膜光滑。';

describe('verifyEvidence', () => {
  it('locates an exact excerpt and reports field-absolute offsets', () => {
    const result = verifyEvidence('未见明显溃疡', CONTEXT, 100);

    expect(result).not.toBeNull();
    expect(result!.start).toBe(100 + CONTEXT.indexOf('未见明显溃疡'));
    expect(result!.end).toBe(result!.start + '未见明显溃疡'.length);
    // The offsets must let a reader recover the excerpt from the field text.
    expect(CONTEXT.slice(result!.start - 100, result!.end - 100)).toBe('未见明显溃疡');
  });

  it('hashes the evidence as returned, not the surrounding text', () => {
    expect(verifyEvidence('未见明显溃疡', CONTEXT, 0)!.hash).toBe(sha256Hex('未见明显溃疡'));
  });

  it('rejects an excerpt that is not in the context', () => {
    // The hallucinated-justification case: fluent, plausible, absent.
    expect(verifyEvidence('胃窦后壁可见一深大溃疡', CONTEXT, 0)).toBeNull();
  });

  it('rejects an excerpt quoted from elsewhere in the report', () => {
    // The model was shown only this window; quoting from outside it is not
    // grounding, even though the text exists in the report.
    const window = '胃窦见巨大溃疡。';
    expect(verifyEvidence('十二指肠球部未见明显溃疡', window, 0)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['one character', '溃'],
  ])('rejects %s as too weak to verify', (_label, evidence) => {
    expect(verifyEvidence(evidence as string | null, CONTEXT, 0)).toBeNull();
  });

  it('rejects an excerpt longer than the context', () => {
    expect(verifyEvidence(CONTEXT + '还有更多', CONTEXT, 0)).toBeNull();
  });

  it('strips the quote characters a model wraps an excerpt in', () => {
    expect(verifyEvidence('“未见明显溃疡”', CONTEXT, 0)).not.toBeNull();
    expect(verifyEvidence('"未见明显溃疡"', CONTEXT, 0)).not.toBeNull();
    expect(verifyEvidence('「未见明显溃疡」', CONTEXT, 0)).not.toBeNull();
  });

  it('tolerates whitespace the model normalized away', () => {
    // Reports are full of newlines and indentation; a model reproducing an
    // excerpt will collapse them. Rejecting that would fail open far more
    // often than the text warrants.
    const multiLine = '检查所见：\n  胃窦见巨大溃疡，\n  表面覆白苔。';
    const result = verifyEvidence('胃窦见巨大溃疡， 表面覆白苔。', multiLine, 0);

    expect(result).not.toBeNull();
    expect(multiLine.slice(result!.start, result!.end)).toContain('胃窦见巨大溃疡');
  });

  it('maps collapsed-whitespace matches back to original offsets', () => {
    const text = '甲。\n\n乙\n溃疡丙';
    const result = verifyEvidence('乙 溃疡丙', text, 0);

    expect(result).not.toBeNull();
    expect(result!.start).toBe(4);
    expect(result!.end).toBe(9);
    // The offsets point at real report text, whitespace and all.
    expect(text.slice(result!.start, result!.end)).toBe('乙\n溃疡丙');
  });

  it('does not tolerate whitespace the model INVENTED', () => {
    // The tolerance is one-directional on purpose: a model may normalize the
    // report's formatting away, but inserting characters the report does not
    // contain is not normalization, and the excerpt is then not faithful.
    expect(verifyEvidence('乙 溃疡丙', '甲乙溃疡丙', 0)).toBeNull();
  });

  it('does not match a substring that only exists after collapsing', () => {
    // Guard against a normalization that is too aggressive: "甲乙" is not in
    // the text, and collapsing must not manufacture it.
    expect(verifyEvidence('甲乙', '甲 乙', 0)).toBeNull();
  });
});
