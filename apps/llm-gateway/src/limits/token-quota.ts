export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
}

/**
 * Per-tenant daily token budget. Cost control: LLM spend scales with tokens, so we cap tokens,
 * not requests.
 */
export interface TokenQuota {
  status(tenantId: string): QuotaStatus;
  /** Records tokens actually consumed (taken from the upstream usage report). */
  record(tenantId: string, tokens: number): void;
}

export const TOKEN_QUOTA = Symbol('TOKEN_QUOTA');

interface Usage {
  day: string;
  used: number;
}

/**
 * In-memory daily quota that resets at 00:00 UTC. The check happens before the call and usage is
 * recorded after it (we only know the real token count afterwards), so a tenant can overshoot by
 * at most the size of its in-flight requests. That is the accepted trade-off versus reserving an
 * estimate up front; see ADR 0003.
 */
export class InMemoryTokenQuota implements TokenQuota {
  private readonly usage = new Map<string, Usage>();

  constructor(
    private readonly dailyLimit: number,
    private readonly now: () => number = Date.now,
  ) {}

  status(tenantId: string): QuotaStatus {
    const used = this.current(tenantId).used;
    return { limit: this.dailyLimit, used, remaining: Math.max(0, this.dailyLimit - used) };
  }

  record(tenantId: string, tokens: number): void {
    this.current(tenantId).used += Math.max(0, tokens);
  }

  private current(tenantId: string): Usage {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const existing = this.usage.get(tenantId);
    if (existing?.day === day) return existing;
    const fresh = { day, used: 0 };
    this.usage.set(tenantId, fresh);
    return fresh;
  }
}
