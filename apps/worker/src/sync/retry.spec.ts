import { Logger } from '@nestjs/common';
import { withRetry } from './retry';

class RetryableError extends Error {
  name = 'PacsHttpTransientError';
}

describe('withRetry', () => {
  it('returns the result immediately when fn succeeds on the first try', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      sleep: async () => undefined,
      isRetryable: () => true,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retryable errors up to maxRetries then succeeds', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new RetryableError('transient');
      return 'ok';
    });
    const sleepCalls: number[] = [];
    const result = await withRetry(fn, {
      maxRetries: 5,
      baseDelayMs: 100,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      isRetryable: (err) => err instanceof RetryableError,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    // exponential backoff: 100, 200
    expect(sleepCalls).toEqual([100, 200]);
  });

  it('throws after exhausting maxRetries', async () => {
    const fn = jest.fn().mockRejectedValue(new RetryableError('always fails'));
    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 1,
        sleep: async () => undefined,
        isRetryable: (err) => err instanceof RetryableError,
      }),
    ).rejects.toThrow('always fails');
    // initial attempt + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-retryable error immediately without retrying', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('auth failure'));
    await expect(
      withRetry(fn, {
        maxRetries: 5,
        baseDelayMs: 1,
        sleep: async () => undefined,
        isRetryable: (err) => err instanceof RetryableError,
      }),
    ).rejects.toThrow('auth failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('logs a warning on each retry attempt when a logger is supplied', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 2) throw new RetryableError('transient');
      return 'ok';
    });
    const logger = new Logger('test');
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      sleep: async () => undefined,
      isRetryable: (err) => err instanceof RetryableError,
      logger,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
