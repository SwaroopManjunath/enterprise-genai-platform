import { RateLimitedError } from '../domain/errors';

/**
 * A fixed-window limit per key (tenant and user). It stops one caller, human or runaway agent,
 * from hammering the servers behind the gateway. A distributed deployment needs a shared counter
 * (Redis); this one is per process.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}

  take(key: string): void {
    const now = this.now();
    if (this.windows.size > 10_000) this.prune(now);

    const window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      return;
    }
    if (window.count >= this.perMinute) {
      throw new RateLimitedError(Math.max(1, Math.ceil((window.start + 60_000 - now) / 1000)));
    }
    window.count += 1;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= 60_000) this.windows.delete(key);
    }
  }
}
