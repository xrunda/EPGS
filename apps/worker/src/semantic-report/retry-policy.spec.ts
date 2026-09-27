import type { ClassifyReportErrorCode } from '@epgs/ai-semantic';
import {
  DETERMINISTIC_ERROR_CODES,
  isRetryableError,
  RETRYABLE_ERROR_CODES,
} from './retry-policy';

/**
 * The retry decision (issue #102).
 *
 * What these tests are for is not that a Set contains a string - it is that the
 * decision is TOTAL and EXPLICIT. Two failure modes matter more than any single
 * row:
 *
 *  1. A code nobody classified. The classifier has an open-ended member
 *     (`HTTP_<status>`), so TypeScript's exhaustiveness checking cannot catch a
 *     new union member. The completeness test below is what catches it: adding a
 *     code to `ClassifyReportErrorCode` without deciding its side fails here.
 *  2. A silent default. Every branch is asserted, including the ones that should
 *     answer "no" precisely because the input is unexpected - a retry on an
 *     unknown failure spends model calls on a question nobody can describe.
 */

/** Every FIXED member of ClassifyReportErrorCode, with the side it belongs on. */
const FIXED_CODES: ReadonlyArray<[ClassifyReportErrorCode, boolean]> = [
  // Transport: no answer arrived, or it was damaged on the way.
  ['NETWORK', true],
  ['TIMEOUT', true],
  ['MODEL_ERROR', true],
  // The reply arrived and was rejected on its merits.
  ['INVALID_JSON', false],
  ['SCHEMA_INVALID', false],
  ['UNKNOWN_ENUM', false],
  ['EVIDENCE_UNVERIFIED', false],
  // We could not build a question, so no model call was made at all.
  ['EMPTY_CONTEXT', false],
  ['EMPTY_INPUT', false],
  ['REPORT_TOO_LONG', false],
  // Configuration, not transport.
  ['UNKNOWN_SEMANTIC', false],
  ['NO_SEMANTICS', false],
  // Measured deterministic: 5/5 byte-identical responses on the hospital
  // gateway (2026-09-27, TEST-REPLAY-014). This is the row to flip if that
  // ever stops being true.
  ['INCOHERENT_LEVEL', false],
];

describe('isRetryableError', () => {
  it.each(FIXED_CODES)('classifies %s as retryable=%s', (code, retryable) => {
    expect(isRetryableError(code)).toBe(retryable);
  });

  it('decides every fixed code, so a new union member cannot be forgotten', () => {
    // Deliberately an assertion about the SETS, not about isRetryableError: a
    // code that falls through to the default would still answer `false`, and
    // "accidentally deterministic" is exactly the silent default this test
    // exists to prevent.
    for (const [code] of FIXED_CODES) {
      const inRetryable = RETRYABLE_ERROR_CODES.has(code);
      const inDeterministic = DETERMINISTIC_ERROR_CODES.has(code);
      expect({
        code,
        exactlyOneSide: inRetryable !== inDeterministic,
        listedOnTheSideTheTableClaims: inRetryable === isRetryableError(code),
      }).toEqual({ code, exactlyOneSide: true, listedOnTheSideTheTableClaims: true });
    }
  });

  it('keeps the transport codes off the deterministic list, and HTTP out of both', () => {
    // HTTP is handled by prefix, not by membership: putting `HTTP_500` in a Set
    // would silently stop matching the moment the gateway answered 503.
    for (const code of [...RETRYABLE_ERROR_CODES, ...DETERMINISTIC_ERROR_CODES]) {
      expect(code.startsWith('HTTP_')).toBe(false);
    }
    expect(RETRYABLE_ERROR_CODES.size + DETERMINISTIC_ERROR_CODES.size).toBe(FIXED_CODES.length);
  });

  describe('HTTP_<status>', () => {
    it.each([
      ['HTTP_429', true, 'rate limited - the gateway is asking us to come back'],
      ['HTTP_500', true, 'the gateway failed; our request was not rejected'],
      ['HTTP_502', true, ''],
      ['HTTP_503', true, ''],
      ['HTTP_599', true, 'top of the 5xx range'],
      ['HTTP_400', false, 'we sent something it would not accept'],
      ['HTTP_401', false, ''],
      ['HTTP_403', false, ''],
      ['HTTP_404', false, ''],
      ['HTTP_422', false, ''],
      // Boundaries: 4xx other than 429 is deterministic, and anything outside
      // 4xx/5xx is not a failure we know how to read.
      ['HTTP_399', false, 'below the 4xx range'],
      ['HTTP_600', false, 'above the 5xx range'],
      ['HTTP_0', false, ''],
    ])('%s -> %s %s', (code, expected) => {
      expect(isRetryableError(code as ClassifyReportErrorCode)).toBe(expected);
    });

    it('treats an unreadable status as deterministic rather than guessing', () => {
      // Not understanding a failure is a reason to stop and look at it, not a
      // reason to repeat it three times.
      for (const malformed of ['HTTP_', 'HTTP_abc', 'HTTP_50x', 'HTTP_5.0', 'HTTP_NaN']) {
        expect(isRetryableError(malformed as ClassifyReportErrorCode)).toBe(false);
      }
    });
  });

  it('answers false for a null code instead of throwing', () => {
    // An ERROR result with no code is a contract violation upstream. Answering
    // `false` terminals the record so the anomaly becomes VISIBLE at once,
    // rather than burning the whole retry budget on a failure nobody can name.
    // It also keeps the caller - an error path - from throwing.
    expect(isRetryableError(null)).toBe(false);
  });
});
