import { InMemoryAnswerCache, type CachedAnswer, type CacheScope } from './answer-cache';
import { CacheStatsTracker } from './cache-stats';
import { cosine, embed } from './question-features';

const answer = (text: string): CachedAnswer => ({
  answer: text,
  citations: [],
  tokens: 100,
  costMicroUsd: 500,
});
const scope = (fingerprint = 'f1', tenantId = 'acme'): CacheScope => ({ tenantId, fingerprint });

function build(overrides: Partial<ConstructorParameters<typeof InMemoryAnswerCache>[0]> = {}) {
  const clock = { now: 1_000_000 };
  const cache = new InMemoryAnswerCache({
    ttlMs: 60_000,
    maxEntriesPerTenant: 3,
    similarity: 0.92,
    now: () => clock.now,
    ...overrides,
  });
  return { cache, clock };
}

describe('InMemoryAnswerCache', () => {
  it('finds an exact repeat, ignoring case and punctuation', () => {
    const { cache } = build();
    cache.store(scope(), 'How long do refunds take?', answer('five days'));

    const hit = cache.lookup(scope(), '  how LONG do refunds take ');

    expect(hit).toMatchObject({ kind: 'exact', similarity: 1, answer: { answer: 'five days' } });
  });

  it('finds the same question in other words', () => {
    const { cache } = build();
    cache.store(scope(), 'How long do refunds take?', answer('five days'));

    const hit = cache.lookup(scope(), 'how long does a refund take');

    expect(hit?.kind).toBe('semantic');
    expect(hit?.similarity).toBeGreaterThan(0.92);
  });

  it('does not match a different question, or one that differs in a number or a negation', () => {
    const { cache } = build();
    cache.store(scope(), 'Is the hotel limit 150 euros per night?', answer('yes'));
    cache.store(scope(), 'Can I block my lost card?', answer('yes'));

    expect(cache.lookup(scope(), 'Is the hotel limit 200 euros per night?')).toBeUndefined();
    expect(cache.lookup(scope(), 'Can I not block my lost card?')).toBeUndefined();
    expect(cache.lookup(scope(), 'What is the weather like?')).toBeUndefined();
  });

  describe('the guard does what similarity cannot', () => {
    // In a long question one changed word barely moves the vector: these pairs are over the
    // similarity threshold, so only the number / negation guard stands between them and a wrong answer.
    it.each([
      [
        'a number',
        'What is the maximum nightly hotel limit for business travel booked through the corporate travel portal for senior staff in euros 150',
        'What is the maximum nightly hotel limit for business travel booked through the corporate travel portal for senior staff in euros 200',
      ],
      [
        'a negation',
        'Can employees working remotely from another country claim reimbursement for their home office internet costs each month',
        'Can employees working remotely from another country not claim reimbursement for their home office internet costs each month',
      ],
      [
        'a year',
        'Please explain how the refund process works for customers who paid with a credit card during the promotional period before 2024',
        'Please explain how the refund process works for customers who paid with a credit card during the promotional period before 2025',
      ],
    ])(
      'refuses a hit that differs in %s even though the vectors are alike',
      (_what, stored, asked) => {
        expect(cosine(embed(stored), embed(asked))).toBeGreaterThan(0.92); // the precondition
        const { cache } = build();
        cache.store(scope(), stored, answer('the answer to the stored question'));

        expect(cache.lookup(scope(), asked)).toBeUndefined();
      },
    );

    it('still serves a long question reworded without changing any of those', () => {
      const { cache } = build();
      const stored =
        'Please explain how the refund process works for customers who paid with a credit card during the promotional period';
      cache.store(scope(), stored, answer('the refund process'));

      const hit = cache.lookup(
        scope(),
        'please explain how the refund process works for customers that paid with credit card in the promotional period',
      );

      expect(hit?.kind).toBe('semantic');
    });
  });

  describe('scope: an answer is only offered to a request that would have produced it', () => {
    it('never crosses tenants', () => {
      const { cache } = build();
      cache.store(scope('f1', 'acme'), 'How long do refunds take?', answer('five days'));

      expect(cache.lookup(scope('f1', 'globex'), 'How long do refunds take?')).toBeUndefined();
    });

    it('never crosses source fingerprints: someone who is shown different documents gets no hit', () => {
      const { cache } = build();
      cache.store(scope('with-restricted-doc'), 'What are the salary bands?', answer('M1 and up'));

      expect(cache.lookup(scope('without-it'), 'What are the salary bands?')).toBeUndefined();
      expect(cache.lookup(scope('without-it'), 'what are the salary band')).toBeUndefined();
      expect(
        cache.lookup(scope('with-restricted-doc'), 'What are the salary bands?'),
      ).toBeDefined();
    });
  });

  it('expires entries after the TTL', () => {
    const { cache, clock } = build();
    cache.store(scope(), 'How long do refunds take?', answer('five days'));

    clock.now += 59_000;
    expect(cache.lookup(scope(), 'How long do refunds take?')).toBeDefined();
    clock.now += 2_000;
    expect(cache.lookup(scope(), 'How long do refunds take?')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond the per-tenant cap, without touching other tenants', () => {
    const { cache, clock } = build({ maxEntriesPerTenant: 2 });
    cache.store(scope('f1', 'other'), 'one other', answer('other'));
    cache.store(scope(), 'question alpha', answer('a'));
    clock.now += 10;
    cache.store(scope(), 'question bravo', answer('b'));
    clock.now += 10;
    cache.lookup(scope(), 'question alpha'); // alpha is now fresher than bravo
    clock.now += 10;
    cache.store(scope(), 'question charlie', answer('c'));

    expect(cache.lookup(scope(), 'question bravo')).toBeUndefined();
    expect(cache.lookup(scope(), 'question alpha')).toBeDefined();
    expect(cache.lookup(scope(), 'question charlie')).toBeDefined();
    expect(cache.lookup(scope('f1', 'other'), 'one other')).toBeDefined();
  });

  it('replaces an entry for the same question rather than keeping two', () => {
    const { cache } = build();
    cache.store(scope(), 'How long do refunds take?', answer('old'));
    cache.store(scope(), 'how long do refunds take', answer('new'));

    expect(cache.lookup(scope(), 'How long do refunds take?')?.answer.answer).toBe('new');
  });

  it('returns copies, so a caller cannot change what is cached', () => {
    const { cache } = build();
    const original = answer('five days');
    cache.store(scope(), 'How long do refunds take?', original);
    original.answer = 'changed after storing';

    expect(cache.lookup(scope(), 'How long do refunds take?')?.answer.answer).toBe('five days');
  });
});

describe('CacheStatsTracker', () => {
  it('counts hits, misses and what hits saved, with a hit rate', () => {
    const stats = new CacheStatsTracker();
    stats.record('acme', { type: 'hit', kind: 'exact', savedTokens: 100, savedMicroUsd: 500 });
    stats.record('acme', { type: 'hit', kind: 'semantic', savedTokens: 80, savedMicroUsd: 400 });
    stats.record('acme', { type: 'miss' });
    stats.record('acme', { type: 'store' });
    stats.record('acme', { type: 'bypass' });

    expect(stats.get('acme')).toMatchObject({
      lookups: 3,
      hits: 2,
      exactHits: 1,
      semanticHits: 1,
      misses: 1,
      bypasses: 1,
      stores: 1,
      savedTokens: 180,
      savedMicroUsd: 900,
      hitRate: 2 / 3,
    });
  });

  it('measures shadow mode: how often it would hit and how often the cached answer was right', () => {
    const stats = new CacheStatsTracker();
    stats.record('acme', {
      type: 'shadow',
      wouldHit: true,
      agreed: true,
      potentialSavedTokens: 100,
      potentialSavedMicroUsd: 500,
    });
    stats.record('acme', {
      type: 'shadow',
      wouldHit: true,
      agreed: false,
      potentialSavedTokens: 100,
      potentialSavedMicroUsd: 500,
    });
    stats.record('acme', { type: 'shadow', wouldHit: false });

    expect(stats.get('acme').shadow).toEqual({
      lookups: 3,
      wouldHit: 2,
      agreed: 1,
      disagreed: 1,
      agreementRate: 0.5,
      potentialSavedTokens: 200,
      potentialSavedMicroUsd: 1000,
    });
    expect(stats.get('acme').hits).toBe(0); // shadow mode serves nothing
  });

  it('has no rates before there is anything to rate, and keeps tenants apart', () => {
    const stats = new CacheStatsTracker();
    stats.record('acme', { type: 'miss' });

    expect(stats.get('globex').hitRate).toBeUndefined();
    expect(stats.get('globex').lookups).toBe(0);
    expect(stats.get('acme').hitRate).toBe(0);
  });
});
