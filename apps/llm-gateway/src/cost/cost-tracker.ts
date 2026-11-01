import type { Cost } from './pricing';

export interface SpendRecord {
  tenantId: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cost: Cost;
  /** True when the answer was streamed rather than returned whole. */
  streamed: boolean;
  /** True when the token counts are our estimate: a stream that ended before the upstream reported usage. */
  estimated?: boolean;
}

export interface ProviderSpend {
  requests: number;
  tokens: number;
  costMicroUsd: number;
}

export interface DaySpend {
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  requests: number;
  streamedRequests: number;
  /** Requests whose token counts were estimated because the stream ended early. */
  estimatedRequests: number;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  /** Requests served by a deployment with no price on file: spend that is not in `costMicroUsd`. */
  unpricedRequests: number;
  byProvider: Record<string, ProviderSpend>;
}

/**
 * What each tenant has spent. Tenant-scoped on every read. In memory here; production writes to a
 * metrics store (the numbers a FinOps dashboard and an invoice would be built from).
 */
export interface CostTracker {
  record(spend: SpendRecord): void;
  /** Today's spend in micro-dollars: what a daily budget is checked against. */
  todayMicroUsd(tenantId: string): number;
  /** The most recent `days` days that had any spend, newest first. */
  summary(tenantId: string, days: number): DaySpend[];
}

export const COST_TRACKER = Symbol('COST_TRACKER');

const emptyDay = (day: string): DaySpend => ({
  day,
  requests: 0,
  streamedRequests: 0,
  estimatedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  costMicroUsd: 0,
  unpricedRequests: 0,
  byProvider: {},
});

export class InMemoryCostTracker implements CostTracker {
  private readonly byTenant = new Map<string, Map<string, DaySpend>>();

  constructor(private readonly now: () => number = Date.now) {}

  record(spend: SpendRecord): void {
    const day = this.today();
    const days = this.byTenant.get(spend.tenantId) ?? new Map<string, DaySpend>();
    const entry = days.get(day) ?? emptyDay(day);

    entry.requests += 1;
    if (spend.streamed) entry.streamedRequests += 1;
    if (spend.estimated) entry.estimatedRequests += 1;
    entry.promptTokens += spend.promptTokens;
    entry.completionTokens += spend.completionTokens;
    entry.costMicroUsd += spend.cost.microUsd;
    if (!spend.cost.priced) entry.unpricedRequests += 1;

    const provider = entry.byProvider[spend.provider] ?? {
      requests: 0,
      tokens: 0,
      costMicroUsd: 0,
    };
    provider.requests += 1;
    provider.tokens += spend.promptTokens + spend.completionTokens;
    provider.costMicroUsd += spend.cost.microUsd;
    entry.byProvider[spend.provider] = provider;

    days.set(day, entry);
    this.byTenant.set(spend.tenantId, days);
  }

  todayMicroUsd(tenantId: string): number {
    return this.byTenant.get(tenantId)?.get(this.today())?.costMicroUsd ?? 0;
  }

  summary(tenantId: string, days: number): DaySpend[] {
    const all = [...(this.byTenant.get(tenantId)?.values() ?? [])];
    return structuredClone(all.sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, days));
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
}
