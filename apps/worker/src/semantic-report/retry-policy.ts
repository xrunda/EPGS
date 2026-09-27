import type { ClassifyReportErrorCode } from '@epgs/ai-semantic';

/**
 * Which failed classification attempts deserve another model call (issue #102).
 *
 * WHY THIS EXISTS AT ALL. Before this file, every ERROR resolved the record on
 * the spot: `maxAttempts` was configured, documented and never reached, because
 * nothing ever put a failed record back in the queue. A gateway blip therefore
 * became a permanent, invisible gap in a doctor's view. The retry budget only
 * becomes real once something decides which failures are worth spending it on.
 *
 * THE SPLIT IS ABOUT THE FAILURE, NOT THE SEVERITY. A retry re-sends the exact
 * same request - same report, same semantics, same temperature of 0 - so the
 * only question is whether asking again could produce a different answer:
 *
 *   RETRYABLE      the answer never arrived, or arrived broken in transit. The
 *                  model was never actually asked a question it answered. Ask
 *                  again.
 *   DETERMINISTIC  an answer arrived and it was unusable - because of what the
 *                  model said, or because of what we sent it. Asking the same
 *                  question again is asking for the same answer.
 *
 * THE MEASUREMENT BEHIND THE STRICTEST CALL. `INCOHERENT_LEVEL` sits on the
 * deterministic side, and that is a measured claim, not a hunch: on the hospital
 * bastion (2026-09-27, isolated `epgs_replay`) the one case that hit it -
 * TEST-REPLAY-014 - returned byte-identical responses on 5 of 5 repeats. It is
 * deterministic. Two honest limits on that: it is a single session's observation
 * rather than a committed experiment, and nothing else in this table has been
 * measured that way at all - this comment says both rather than implying the
 * whole table is equally evidenced.
 *
 * If that gateway turns out to jitter after all, this is the ONE place to flip:
 * one Set entry, one line, no scattered conditionals to hunt down. That is why
 * the table is data rather than a chain of `if`s.
 *
 * WHERE THE RETRY BUDGET ITSELF LIVES: not here. This file only answers "worth
 * asking again?"; SEMANTIC_REPORT_MAX_ATTEMPTS and the claim query's
 * `aiAttempts < maxAttempts` bound how many times. One policy, one counter.
 */

/**
 * Failures where the request or the response was damaged in transit, or where no
 * answer arrived at all. Another identical call is a genuinely different roll of
 * the dice.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ClassifyReportErrorCode> = new Set([
  /** The request never produced a response (DNS, connection refused, socket reset). */
  'NETWORK',
  /** The call exceeded timeoutMs and was aborted. */
  'TIMEOUT',
  /** Something was thrown that is not any of the above - treated as transport. */
  'MODEL_ERROR',
]);

/**
 * Failures where a complete answer arrived and was rejected on its merits, or
 * where we could not have asked a meaningful question in the first place.
 * Re-sending the same bytes cannot change any of these.
 *
 * Each entry is a decision, so each one is stated:
 *
 *   INVALID_JSON / SCHEMA_INVALID / UNKNOWN_ENUM
 *     The reply parsed but did not fit the contract. Same input, same prompt,
 *     same model - at temperature 0 the contract has already been missed.
 *   EVIDENCE_UNVERIFIED
 *     The model quoted an excerpt that is not in the text we sent. Re-asking
 *     does not put the words back.
 *   EMPTY_CONTEXT / EMPTY_INPUT / REPORT_TOO_LONG
 *     We could not build a question. No model call was even made for these, so
 *     "retry" would mean "repeat the same local check".
 *   UNKNOWN_SEMANTIC
 *     The model named a semantic that was not in the configuration sent to it.
 *     Retrying against an unchanged configuration asks the same unanswerable
 *     question; the fix is the configuration.
 *   INCOHERENT_LEVEL
 *     The model's stated overall level disagrees with the colours of the
 *     semantics it itself listed. Measured deterministic - see the module
 *     comment. Refusing it is correct; retrying it is pointless.
 *   NO_SEMANTICS
 *     A race-only precondition: the configuration emptied between the worker's
 *     "are there semantics?" check and the call. It is not a transport hiccup,
 *     and treating it as terminal is honest - the record genuinely was not
 *     judged. The service re-checks the configuration every tick, so a
 *     configured hospital recovers on its own; `classify:once --requeue
 *     --failed-only` is the deliberate way back for a record that terminaled
 *     while the configuration was being edited.
 */
export const DETERMINISTIC_ERROR_CODES: ReadonlySet<ClassifyReportErrorCode> = new Set([
  'INVALID_JSON',
  'SCHEMA_INVALID',
  'UNKNOWN_ENUM',
  'EVIDENCE_UNVERIFIED',
  'EMPTY_CONTEXT',
  'EMPTY_INPUT',
  'REPORT_TOO_LONG',
  'UNKNOWN_SEMANTIC',
  'INCOHERENT_LEVEL',
  'NO_SEMANTICS',
]);

/**
 * Is another identical call worth spending on this failure?
 *
 * TOTALS ON EVERY INPUT, including inputs that should not occur, because the
 * caller is an error path and an error path that throws is worse than an error
 * path that guesses:
 *
 *   - `null` on an ERROR result is a contract violation upstream. Answered
 *     `false` so the record terminals and becomes VISIBLE at once, rather than
 *     burning three model calls on a failure nobody can name.
 *   - An `HTTP_<n>` we cannot read as a number, or a status outside 4xx/5xx,
 *     is likewise `false`. Not understanding a failure is a reason to stop and
 *     look at it, not a reason to repeat it.
 */
export function isRetryableError(code: ClassifyReportErrorCode | null): boolean {
  if (code === null) return false;
  if (RETRYABLE_ERROR_CODES.has(code)) return true;
  if (DETERMINISTIC_ERROR_CODES.has(code)) return false;

  // Everything left is `HTTP_<status>` - the only open-ended member of the
  // union, and the one place a number from the transport appears.
  const status = httpStatus(code);
  if (status === null) return false;

  // 429: rate limited, not broken. The gateway is explicitly telling us to come
  // back later, which is the clearest retry signal in HTTP.
  if (status === 429) return true;
  // 5xx: the gateway or the model server failed. Nothing about our request was
  // rejected, so the same request is a fair question to ask again.
  return status >= 500 && status <= 599;
}

/** Parse the status out of `HTTP_<status>`; null when it is not a status at all. */
function httpStatus(code: string): number | null {
  if (!code.startsWith('HTTP_')) return null;
  const status = Number.parseInt(code.slice('HTTP_'.length), 10);
  return Number.isInteger(status) ? status : null;
}
