export interface RateLimitDecision {
  allowed: boolean;
  /** How long until a request would be allowed; 0 when allowed. */
  retryAfterMs: number;
}

/**
 * Per-tenant request rate limiting. The in-memory implementation is correct for a single
 * replica; running several replicas needs a shared store (Redis) behind this same interface.
 */
export interface RateLimiter {
  tryConsume(tenantId: string): RateLimitDecision;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket: each tenant holds up to `requestsPerMinute` tokens that refill continuously.
 * Unlike a fixed window it allows short bursts but cannot be gamed by sending a full quota at
 * the end of one minute and another at the start of the next.
 */
export class InMemoryTokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.refillPerMs = requestsPerMinute / 60_000;
  }

  tryConsume(tenantId: string): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(tenantId) ?? { tokens: this.requestsPerMinute, updatedAt: now };

    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.requestsPerMinute, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(tenantId, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / this.refillPerMs) };
  }
}
