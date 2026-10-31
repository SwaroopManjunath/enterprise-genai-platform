import { ProviderError } from '../llm/provider-error';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; must return a number in [0, 1). */
  random?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying retryable ProviderErrors with exponential backoff and full jitter.
 *
 * Full jitter (a random wait between 0 and the exponential cap) stops many callers that failed
 * together from retrying together and hammering a recovering upstream in lockstep.
 *
 * If the upstream asks us to wait longer than maxDelayMs (Retry-After), we stop retrying here and
 * surface the error so the caller can fall back to another deployment instead of stalling.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || attempt >= options.maxAttempts) {
        throw error;
      }

      const delay = nextDelay(error, attempt, options, random);
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

function nextDelay(
  error: ProviderError,
  attempt: number,
  options: RetryOptions,
  random: () => number,
): number | undefined {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs > options.maxDelayMs ? undefined : error.retryAfterMs;
  }
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}
