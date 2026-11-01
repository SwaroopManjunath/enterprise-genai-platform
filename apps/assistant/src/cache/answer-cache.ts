import type { Citation } from '../ask/citations';
import { cosine, embed, mustMatch, normalize } from './question-features';

/** A verified answer, stored after every guardrail and citation check has already run. */
export interface CachedAnswer {
  answer: string;
  citations: Citation[];
  /** What generating it cost, so a hit can say what it saved. */
  tokens: number;
  costMicroUsd: number;
}

/**
 * What an answer depends on besides the wording of the question: the tenant, and a fingerprint of
 * exactly what the model was given (the sources retrieved for THIS user, and the prompt version).
 * An entry is only ever offered to a request with the same scope.
 */
export interface CacheScope {
  tenantId: string;
  fingerprint: string;
}

export interface CacheHit {
  kind: 'exact' | 'semantic';
  similarity: number;
  answer: CachedAnswer;
}

export interface AnswerCache {
  lookup(scope: CacheScope, question: string): CacheHit | undefined;
  store(scope: CacheScope, question: string, answer: CachedAnswer): void;
}

export const ANSWER_CACHE = Symbol('ANSWER_CACHE');

export interface AnswerCacheOptions {
  ttlMs: number;
  /** Per tenant, so one busy tenant cannot push another's entries out. */
  maxEntriesPerTenant: number;
  /** Minimum cosine similarity for a semantic hit (an exact repeat needs none). */
  similarity: number;
  now?: () => number;
}

interface Entry {
  fingerprint: string;
  normalized: string;
  vector: number[];
  must: string;
  answer: CachedAnswer;
  storedAt: number;
  lastUsedAt: number;
}

/**
 * In-memory cache of answers. Production target: Redis with vector search, partitioned by tenant.
 *
 * A lookup finds an entry only if it has the same tenant AND the same fingerprint of the sources the
 * caller may see: because the caller's own retrieval produced that fingerprint, an answer built from
 * documents one user can read can never be offered to a user who cannot. Within a scope, a question
 * matches an earlier one exactly (after normalising), or semantically when it clears the similarity
 * threshold AND shares every number, identifier and meaning-flipping word with it.
 */
export class InMemoryAnswerCache implements AnswerCache {
  private readonly entries = new Map<string, Entry[]>();
  private readonly now: () => number;

  constructor(private readonly options: AnswerCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  lookup(scope: CacheScope, question: string): CacheHit | undefined {
    const now = this.now();
    const live = this.live(scope.tenantId, now).filter((e) => e.fingerprint === scope.fingerprint);
    if (live.length === 0) return undefined;

    const normalized = normalize(question);
    const exact = live.find((e) => e.normalized === normalized);
    if (exact) {
      exact.lastUsedAt = now;
      return { kind: 'exact', similarity: 1, answer: exact.answer };
    }

    const vector = embed(question);
    const must = mustMatch(question);
    let best: { entry: Entry; similarity: number } | undefined;
    for (const entry of live) {
      if (entry.must !== must) continue;
      const similarity = cosine(vector, entry.vector);
      if (similarity >= this.options.similarity && similarity > (best?.similarity ?? 0)) {
        best = { entry, similarity };
      }
    }
    if (!best) return undefined;

    best.entry.lastUsedAt = now;
    return { kind: 'semantic', similarity: best.similarity, answer: best.entry.answer };
  }

  store(scope: CacheScope, question: string, answer: CachedAnswer): void {
    const now = this.now();
    const normalized = normalize(question);
    const all = this.live(scope.tenantId, now);

    const existing = all.find(
      (e) => e.fingerprint === scope.fingerprint && e.normalized === normalized,
    );
    const kept = existing ? all.filter((e) => e !== existing) : all;
    kept.push({
      fingerprint: scope.fingerprint,
      normalized,
      vector: embed(question),
      must: mustMatch(question),
      answer: structuredClone(answer),
      storedAt: now,
      lastUsedAt: now,
    });

    while (kept.length > this.options.maxEntriesPerTenant) {
      const oldest = kept.reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b));
      kept.splice(kept.indexOf(oldest), 1);
    }
    this.entries.set(scope.tenantId, kept);
  }

  /** The tenant's unexpired entries (and drops the expired ones as a side effect). */
  private live(tenantId: string, now: number): Entry[] {
    const fresh = (this.entries.get(tenantId) ?? []).filter(
      (e) => now - e.storedAt < this.options.ttlMs,
    );
    this.entries.set(tenantId, fresh);
    return fresh;
  }
}
