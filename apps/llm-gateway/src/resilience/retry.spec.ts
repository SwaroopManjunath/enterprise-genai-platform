import { ProviderError } from '../llm/provider-error';
import { withRetry } from './retry';

const options = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

function setup() {
  const delays: number[] = [];
  return {
    delays,
    opts: {
      ...options,
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    },
  };
}

describe('withRetry', () => {
  it('returns immediately on success without sleeping', async () => {
    const { opts, delays } = setup();
    const fn = jest.fn().mockResolvedValue('ok');

    await expect(withRetry(fn, opts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries retryable errors with exponential, jittered backoff', async () => {
    const { opts, delays } = setup();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new ProviderError('p', 'busy', { status: 429 }))
      .mockRejectedValueOnce(new ProviderError('p', 'down', { status: 503 }))
      .mockResolvedValue('ok');

    await expect(withRetry(fn, opts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    // random=0.5: 0.5 * 100, then 0.5 * 200
    expect(delays).toEqual([50, 100]);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const { opts } = setup();
    const error = new ProviderError('p', 'down', { status: 503 });
    const fn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(fn, opts)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const { opts } = setup();
    const error = new ProviderError('p', 'bad request', { status: 400 });
    const fn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(fn, opts)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry unknown errors (bugs must surface, not loop)', async () => {
    const { opts } = setup();
    const fn = jest.fn().mockRejectedValue(new TypeError('bug'));

    await expect(withRetry(fn, opts)).rejects.toThrow('bug');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours a short Retry-After instead of computing a backoff', async () => {
    const { opts, delays } = setup();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new ProviderError('p', 'busy', { status: 429, retryAfterMs: 700 }))
      .mockResolvedValue('ok');

    await withRetry(fn, opts);
    expect(delays).toEqual([700]);
  });

  it('stops retrying when Retry-After exceeds the max delay, so fallback can take over', async () => {
    const { opts, delays } = setup();
    const error = new ProviderError('p', 'busy', { status: 429, retryAfterMs: 60_000 });
    const fn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(fn, opts)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
