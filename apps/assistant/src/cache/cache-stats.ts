/** What happened to one lookup, for the numbers a cost review needs. */
export type CacheEvent =
  | { type: 'hit'; kind: 'exact' | 'semantic'; savedTokens: number; savedMicroUsd: number }
  | { type: 'miss' }
  | { type: 'bypass' }
  | { type: 'store' }
  | {
      /** Shadow mode: nothing was served from the cache; this is what would have happened. */
      type: 'shadow';
      wouldHit: boolean;
      /** Only when it would have hit: did the cached answer match the freshly generated one? */
      agreed?: boolean;
      potentialSavedTokens?: number;
      potentialSavedMicroUsd?: number;
    };

export interface CacheStats {
  lookups: number;
  hits: number;
  exactHits: number;
  semanticHits: number;
  misses: number;
  /** Requests that asked for a fresh answer (`noCache`). */
  bypasses: number;
  stores: number;
  /** Hits over hits plus misses; absent until there has been one of either. */
  hitRate?: number;
  savedTokens: number;
  savedMicroUsd: number;
  shadow: {
    lookups: number;
    wouldHit: number;
    agreed: number;
    disagreed: number;
    /** Of the answers that would have been served, the share identical to a fresh one. */
    agreementRate?: number;
    potentialSavedTokens: number;
    potentialSavedMicroUsd: number;
  };
}

const empty = (): CacheStats => ({
  lookups: 0,
  hits: 0,
  exactHits: 0,
  semanticHits: 0,
  misses: 0,
  bypasses: 0,
  stores: 0,
  savedTokens: 0,
  savedMicroUsd: 0,
  shadow: {
    lookups: 0,
    wouldHit: 0,
    agreed: 0,
    disagreed: 0,
    potentialSavedTokens: 0,
    potentialSavedMicroUsd: 0,
  },
});

/** Per-tenant counters. Reads are tenant-scoped, like everything else. */
export class CacheStatsTracker {
  private readonly byTenant = new Map<string, CacheStats>();

  record(tenantId: string, event: CacheEvent): void {
    const s = this.byTenant.get(tenantId) ?? empty();
    switch (event.type) {
      case 'hit':
        s.lookups += 1;
        s.hits += 1;
        if (event.kind === 'exact') s.exactHits += 1;
        else s.semanticHits += 1;
        s.savedTokens += event.savedTokens;
        s.savedMicroUsd += event.savedMicroUsd;
        break;
      case 'miss':
        s.lookups += 1;
        s.misses += 1;
        break;
      case 'bypass':
        s.bypasses += 1;
        break;
      case 'store':
        s.stores += 1;
        break;
      case 'shadow':
        s.shadow.lookups += 1;
        if (event.wouldHit) {
          s.shadow.wouldHit += 1;
          if (event.agreed) s.shadow.agreed += 1;
          else s.shadow.disagreed += 1;
          s.shadow.potentialSavedTokens += event.potentialSavedTokens ?? 0;
          s.shadow.potentialSavedMicroUsd += event.potentialSavedMicroUsd ?? 0;
        }
        break;
    }
    this.byTenant.set(tenantId, s);
  }

  get(tenantId: string): CacheStats {
    const s = structuredClone(this.byTenant.get(tenantId) ?? empty());
    const asked = s.hits + s.misses;
    if (asked > 0) s.hitRate = s.hits / asked;
    if (s.shadow.wouldHit > 0) s.shadow.agreementRate = s.shadow.agreed / s.shadow.wouldHit;
    return s;
  }
}
