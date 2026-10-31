export interface ProviderErrorOptions {
  /** HTTP status from upstream, undefined for network failures and timeouts. */
  status?: number;
  /** Server-requested wait before retrying (Retry-After), in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * Failure from an upstream LLM call, classified so callers can decide what to do:
 *  - retryable: same deployment may succeed if we try again shortly (429, 5xx, network)
 *  - fallbackable: another deployment may succeed even if this one never will
 *    (auth/config problems on one deployment, or it staying down)
 * A request the upstream rejected as malformed (400/422) is neither: every deployment
 * would reject it, so retrying or falling back only burns quota and latency.
 */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  readonly fallbackable: boolean;

  constructor(
    readonly provider: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(`[${provider}] ${message}`, { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;

    const status = options.status;
    if (status === undefined) {
      this.retryable = true;
      this.fallbackable = true;
    } else if (status === 429 || status >= 500) {
      this.retryable = true;
      this.fallbackable = true;
    } else if (status === 401 || status === 403 || status === 404) {
      this.retryable = false;
      this.fallbackable = true;
    } else {
      this.retryable = false;
      this.fallbackable = false;
    }
  }
}
