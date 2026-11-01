import { InMemoryCostTracker } from './cost-tracker';
import { PriceBook, microToUsd, usdToMicro } from './pricing';

const prices = new PriceBook({
  'aoai-primary': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'aoai-small': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
});

describe('PriceBook', () => {
  it('prices tokens exactly: dollars per million tokens is micro-dollars per token', () => {
    expect(prices.cost('aoai-primary', { promptTokens: 1000, completionTokens: 200 })).toEqual({
      microUsd: 2500 + 2000,
      priced: true,
    });
  });

  it('rounds to a whole micro-dollar and never returns a fraction', () => {
    const cost = prices.cost('aoai-small', { promptTokens: 7, completionTokens: 3 });

    expect(Number.isInteger(cost.microUsd)).toBe(true);
    expect(cost.microUsd).toBe(Math.round(7 * 0.15 + 3 * 0.6));
  });

  it('says so when a deployment has no price, instead of pretending it was free', () => {
    expect(prices.cost('mystery', { promptTokens: 1000, completionTokens: 1000 })).toEqual({
      microUsd: 0,
      priced: false,
    });
  });

  it('converts between dollars and micro-dollars', () => {
    expect(usdToMicro(1.5)).toBe(1_500_000);
    expect(microToUsd(2_500)).toBe(0.0025);
  });
});

describe('InMemoryCostTracker', () => {
  const record = (tracker: InMemoryCostTracker, tenantId: string, extra = {}) =>
    tracker.record({
      tenantId,
      provider: 'aoai-primary',
      promptTokens: 100,
      completionTokens: 50,
      cost: { microUsd: 750, priced: true },
      streamed: false,
      ...extra,
    });

  it('adds up a tenant’s day by provider', () => {
    const tracker = new InMemoryCostTracker(() => Date.parse('2026-11-01T10:00:00Z'));
    record(tracker, 'acme');
    record(tracker, 'acme', { streamed: true });
    record(tracker, 'acme', { provider: 'aoai-small', cost: { microUsd: 20, priced: true } });

    expect(tracker.summary('acme', 7)).toEqual([
      {
        day: '2026-11-01',
        requests: 3,
        streamedRequests: 1,
        promptTokens: 300,
        completionTokens: 150,
        costMicroUsd: 750 + 750 + 20,
        unpricedRequests: 0,
        byProvider: {
          'aoai-primary': { requests: 2, tokens: 300, costMicroUsd: 1500 },
          'aoai-small': { requests: 1, tokens: 150, costMicroUsd: 20 },
        },
      },
    ]);
  });

  it('counts unpriced requests apart from priced spend', () => {
    const tracker = new InMemoryCostTracker();
    record(tracker, 'acme', { cost: { microUsd: 0, priced: false } });

    expect(tracker.summary('acme', 1)[0]).toMatchObject({ costMicroUsd: 0, unpricedRequests: 1 });
  });

  it('keeps tenants apart', () => {
    const tracker = new InMemoryCostTracker();
    record(tracker, 'acme');

    expect(tracker.todayMicroUsd('acme')).toBe(750);
    expect(tracker.todayMicroUsd('globex')).toBe(0);
    expect(tracker.summary('globex', 7)).toEqual([]);
  });

  it('starts a new day at 00:00 UTC, lists newest first and honours the day limit', () => {
    const clock = { now: Date.parse('2026-11-01T23:59:00Z') };
    const tracker = new InMemoryCostTracker(() => clock.now);
    record(tracker, 'acme');
    clock.now = Date.parse('2026-11-02T00:01:00Z');
    record(tracker, 'acme');
    record(tracker, 'acme');

    expect(tracker.todayMicroUsd('acme')).toBe(1500);
    expect(tracker.summary('acme', 7).map((d) => [d.day, d.requests])).toEqual([
      ['2026-11-02', 2],
      ['2026-11-01', 1],
    ]);
    expect(tracker.summary('acme', 1)).toHaveLength(1);
  });

  it('returns copies, so a caller cannot change what was recorded', () => {
    const tracker = new InMemoryCostTracker();
    record(tracker, 'acme');

    (tracker.summary('acme', 1)[0] as { requests: number }).requests = 999;

    expect(tracker.summary('acme', 1)[0]?.requests).toBe(1);
  });
});
