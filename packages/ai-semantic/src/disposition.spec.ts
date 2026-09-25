import { decideDisposition, isCoherent } from './disposition';
import { SemanticConfidence, SemanticStatus, ValidateMatchVerdict } from './types';

/**
 * The disposition matrix (issue #87 §7).
 *
 * These are the acceptance samples the issue lists, expressed at the level of
 * the decision function rather than end-to-end, so a failure here says exactly
 * which rule of the matrix broke. The end-to-end samples (with a fake model
 * and a real report excerpt) are in validate-match.spec.ts.
 */

function verdict(
  semanticStatus: SemanticStatus,
  confidence: SemanticConfidence,
  overrides: Partial<ValidateMatchVerdict> = {},
): ValidateMatchVerdict {
  // Default `matched` to whatever is coherent for the status, so each test
  // states only what it is actually about.
  const coherent = semanticStatus === 'NEGATED' || semanticStatus === 'HISTORY' ? false : true;
  return {
    matched: coherent,
    semanticStatus,
    confidence,
    reason: 'r',
    evidence: 'e',
    intentExcludesHistory: false,
    ...overrides,
  };
}

describe('decideDisposition - the required acceptance samples', () => {
  it('胃窦见巨大溃疡 -> PRESENT -> keep', () => {
    expect(decideDisposition(verdict('PRESENT', 'HIGH'))).toEqual({
      filtered: false,
      reason: 'PRESENT_KEEP',
    });
  });

  it('未见明显溃疡 -> NEGATED + HIGH -> filter', () => {
    expect(decideDisposition(verdict('NEGATED', 'HIGH'))).toEqual({
      filtered: true,
      reason: 'NEGATED_HIGH_FILTER',
    });
  });

  it('胃溃疡病史 + intent excluding history -> HISTORY + HIGH -> filter', () => {
    expect(decideDisposition(verdict('HISTORY', 'HIGH', { intentExcludesHistory: true }))).toEqual({
      filtered: true,
      reason: 'HISTORY_HIGH_FILTER',
    });
  });

  it('考虑胃溃疡可能 -> SUSPECTED -> keep', () => {
    expect(decideDisposition(verdict('SUSPECTED', 'HIGH'))).toEqual({
      filtered: false,
      reason: 'SUSPECTED_KEEP',
    });
  });

  it('不能除外溃疡 -> SUSPECTED -> keep', () => {
    expect(decideDisposition(verdict('SUSPECTED', 'MEDIUM'))).toEqual({
      filtered: false,
      reason: 'SUSPECTED_KEEP',
    });
  });

  it('insufficient context -> UNCERTAIN -> keep', () => {
    expect(decideDisposition(verdict('UNCERTAIN', 'LOW'))).toEqual({
      filtered: false,
      reason: 'UNCERTAIN_KEEP',
    });
  });

  it('NEGATED + LOW -> keep', () => {
    expect(decideDisposition(verdict('NEGATED', 'LOW'))).toEqual({
      filtered: false,
      reason: 'NEGATED_NOT_HIGH_KEEP',
    });
  });
});

describe('decideDisposition - confidence gating', () => {
  it.each(['MEDIUM', 'LOW'] as const)('NEGATED + %s never filters', (confidence) => {
    expect(decideDisposition(verdict('NEGATED', confidence)).filtered).toBe(false);
  });

  it.each(['MEDIUM', 'LOW'] as const)(
    'HISTORY + %s never filters, even with an excluding intent',
    (confidence) => {
      expect(
        decideDisposition(verdict('HISTORY', confidence, { intentExcludesHistory: true })).filtered,
      ).toBe(false);
    },
  );

  it('HISTORY + HIGH does NOT filter when the intent does not exclude history', () => {
    expect(decideDisposition(verdict('HISTORY', 'HIGH', { intentExcludesHistory: false }))).toEqual(
      { filtered: false, reason: 'HISTORY_INTENT_INCLUDES_KEEP' },
    );
  });
});

describe('decideDisposition - incoherent verdicts fail open', () => {
  it('NEGATED with matched=true does not filter', () => {
    // The safety-critical asymmetry: a self-contradicting verdict must never
    // reach a filtering branch.
    expect(decideDisposition(verdict('NEGATED', 'HIGH', { matched: true }))).toEqual({
      filtered: false,
      reason: 'MALFORMED_VERDICT_KEEP',
    });
  });

  it('HISTORY with matched=true does not filter', () => {
    expect(
      decideDisposition(verdict('HISTORY', 'HIGH', { matched: true, intentExcludesHistory: true })),
    ).toEqual({ filtered: false, reason: 'MALFORMED_VERDICT_KEEP' });
  });

  it.each(['PRESENT', 'SUSPECTED'] as const)(
    '%s with matched=false is malformed and kept',
    (status) => {
      expect(decideDisposition(verdict(status, 'HIGH', { matched: false }))).toEqual({
        filtered: false,
        reason: 'MALFORMED_VERDICT_KEEP',
      });
    },
  );

  it('UNCERTAIN is coherent with either matched value', () => {
    expect(isCoherent(verdict('UNCERTAIN', 'HIGH', { matched: true }))).toBe(true);
    expect(isCoherent(verdict('UNCERTAIN', 'HIGH', { matched: false }))).toBe(true);
  });
});

describe('decideDisposition - no unexpected filtering', () => {
  const statuses: SemanticStatus[] = ['PRESENT', 'NEGATED', 'SUSPECTED', 'HISTORY', 'UNCERTAIN'];
  const confidences: SemanticConfidence[] = ['HIGH', 'MEDIUM', 'LOW'];

  it('filters ONLY for NEGATED+HIGH and HISTORY+HIGH+excluding-intent, across the whole matrix', () => {
    const filtering: string[] = [];
    for (const status of statuses) {
      for (const confidence of confidences) {
        for (const intentExcludesHistory of [true, false]) {
          const decision = decideDisposition(
            verdict(status, confidence, { intentExcludesHistory }),
          );
          if (decision.filtered) {
            filtering.push(`${status}/${confidence}/${intentExcludesHistory}`);
          }
        }
      }
    }
    expect(filtering.sort()).toEqual([
      'HISTORY/HIGH/true',
      'NEGATED/HIGH/false',
      'NEGATED/HIGH/true',
    ]);
  });
});
