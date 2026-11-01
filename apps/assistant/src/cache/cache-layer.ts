import type { PromptInfo } from '../ask/ask.service';
import type { Source } from '../ask/sources';
import {
  type AnswerCache,
  type CachedAnswer,
  type CacheHit,
  type CacheScope,
} from './answer-cache';
import type { CacheStatsTracker } from './cache-stats';
import { sourcesFingerprint } from './fingerprint';

/**
 *  - `off`: no caching at all.
 *  - `shadow`: look up and store, but always generate a fresh answer, and record whether the cached
 *    answer would have matched it. The way to learn a cache's hit rate and error rate on real
 *    traffic before letting it answer anyone.
 *  - `serve`: answer from the cache when it hits.
 */
export type CacheMode = 'off' | 'shadow' | 'serve';

/** What the assistant needs from caching: a mode, a scope for each request, and the counters. */
export class CacheLayer {
  constructor(
    readonly mode: CacheMode,
    private readonly cache: AnswerCache,
    readonly stats: CacheStatsTracker,
    private readonly epoch: string,
  ) {}

  scope(
    tenantId: string,
    sources: readonly Source[],
    prompt: PromptInfo,
    guardrailsMode: string,
  ): CacheScope {
    return {
      tenantId,
      fingerprint: sourcesFingerprint(sources, prompt, { guardrailsMode, epoch: this.epoch }),
    };
  }

  lookup(scope: CacheScope, question: string): CacheHit | undefined {
    return this.cache.lookup(scope, question);
  }

  store(scope: CacheScope, question: string, answer: CachedAnswer): void {
    this.cache.store(scope, question, answer);
    this.stats.record(scope.tenantId, { type: 'store' });
  }
}
