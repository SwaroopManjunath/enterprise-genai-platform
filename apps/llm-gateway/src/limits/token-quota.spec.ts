import { InMemoryTokenQuota } from './token-quota';

describe('InMemoryTokenQuota', () => {
  it('tracks usage per tenant', () => {
    const quota = new InMemoryTokenQuota(1000, () => 0);

    quota.record('acme', 300);
    quota.record('acme', 200);

    expect(quota.status('acme')).toEqual({ limit: 1000, used: 500, remaining: 500 });
    expect(quota.status('globex').used).toBe(0);
  });

  it('reports zero remaining (never negative) once exceeded', () => {
    const quota = new InMemoryTokenQuota(100, () => 0);

    quota.record('acme', 250);

    expect(quota.status('acme').remaining).toBe(0);
  });

  it('resets at the UTC day boundary', () => {
    let now = Date.UTC(2026, 0, 1, 23, 59, 0);
    const quota = new InMemoryTokenQuota(100, () => now);
    quota.record('acme', 100);
    expect(quota.status('acme').remaining).toBe(0);

    now += 2 * 60_000; // two minutes later: past midnight UTC

    expect(quota.status('acme').remaining).toBe(100);
  });

  it('ignores negative token counts', () => {
    const quota = new InMemoryTokenQuota(100, () => 0);
    quota.record('acme', -50);
    expect(quota.status('acme').used).toBe(0);
  });
});
