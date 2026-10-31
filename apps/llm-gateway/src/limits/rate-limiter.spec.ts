import { InMemoryTokenBucketRateLimiter } from './rate-limiter';

describe('InMemoryTokenBucketRateLimiter', () => {
  it('allows a burst up to the limit, then rejects with a retry hint', () => {
    const limiter = new InMemoryTokenBucketRateLimiter(60, () => 0); // 1 token per second

    for (let i = 0; i < 60; i++) {
      expect(limiter.tryConsume('acme').allowed).toBe(true);
    }
    const rejected = limiter.tryConsume('acme');

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(1000);
  });

  it('refills over time', () => {
    let now = 0;
    const limiter = new InMemoryTokenBucketRateLimiter(60, () => now);
    for (let i = 0; i < 60; i++) limiter.tryConsume('acme');
    expect(limiter.tryConsume('acme').allowed).toBe(false);

    now += 2000; // two tokens refilled

    expect(limiter.tryConsume('acme').allowed).toBe(true);
    expect(limiter.tryConsume('acme').allowed).toBe(true);
    expect(limiter.tryConsume('acme').allowed).toBe(false);
  });

  it('never refills beyond capacity', () => {
    let now = 0;
    const limiter = new InMemoryTokenBucketRateLimiter(2, () => now);
    now += 10 * 60_000;

    expect(limiter.tryConsume('acme').allowed).toBe(true);
    expect(limiter.tryConsume('acme').allowed).toBe(true);
    expect(limiter.tryConsume('acme').allowed).toBe(false);
  });

  it('isolates tenants: one noisy tenant cannot starve another', () => {
    const limiter = new InMemoryTokenBucketRateLimiter(1, () => 0);

    expect(limiter.tryConsume('noisy').allowed).toBe(true);
    expect(limiter.tryConsume('noisy').allowed).toBe(false);
    expect(limiter.tryConsume('quiet').allowed).toBe(true);
  });
});
