import { Logger } from '@nestjs/common';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  /** Injectable sleep function so tests don't wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Only errors this predicate accepts are retried; anything else rethrows immediately. */
  isRetryable: (err: unknown) => boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` with exponential backoff on retryable errors:
 * delay = baseDelayMs * 2^attempt (attempt starting at 0), no jitter
 * (kept deterministic on purpose so tests can assert exact call counts
 * without timing flakiness).
 *
 * This is used ONLY for whole-batch/page-level failures (e.g. the
 * adapter's fetchReports() throwing a transient network/503/429 error) -
 * per-report processing errors are handled separately inside the sync
 * runner (they must not abort or retry the whole batch, just skip that
 * one record and keep going - see sync-runner.ts).
 *
 * Non-retryable errors (isRetryable returns false) propagate immediately
 * without consuming a retry attempt, so e.g. a 401 auth failure fails
 * fast instead of retrying 5 times against a config error.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!options.isRetryable(err) || attempt >= options.maxRetries) {
        throw err;
      }
      const delayMs = options.baseDelayMs * 2 ** attempt;
      options.logger?.warn(
        `retrying after transient error (attempt ${attempt + 1}/${options.maxRetries}, delay ${delayMs}ms): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      attempt += 1;
      await sleep(delayMs);
    }
  }
}
