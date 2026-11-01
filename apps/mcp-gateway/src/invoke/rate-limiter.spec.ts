import { RateLimitedError } from '../domain/errors';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('allows up to the limit per key, then says when to retry', () => {
    const clock = { now: 0 };
    const limiter = new RateLimiter(2, () => clock.now);

    limiter.take('a');
    limiter.take('a');
    clock.now = 20_000;

    const error = (() => {
      try {
        limiter.take('a');
      } catch (e) {
        return e as RateLimitedError;
      }
    })();
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error?.retryAfterSeconds).toBe(40);
  });

  it('counts each key separately and starts a new window after a minute', () => {
    const clock = { now: 0 };
    const limiter = new RateLimiter(1, () => clock.now);

    limiter.take('a');
    expect(() => limiter.take('b')).not.toThrow();
    expect(() => limiter.take('a')).toThrow(RateLimitedError);
    clock.now = 60_000;
    expect(() => limiter.take('a')).not.toThrow();
  });
});
