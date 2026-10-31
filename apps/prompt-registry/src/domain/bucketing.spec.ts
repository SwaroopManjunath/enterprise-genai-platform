import { hashToUnitInterval, pickVariant } from './bucketing';

describe('hashToUnitInterval', () => {
  it('is deterministic and within [0, 1)', () => {
    const a = hashToUnitInterval('tenant:prompt:user-1');
    expect(hashToUnitInterval('tenant:prompt:user-1')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });
});

describe('pickVariant', () => {
  const variants = [
    { value: 'A', weight: 1 },
    { value: 'B', weight: 1 },
  ];

  it('is sticky: the same key always gets the same variant', () => {
    const first = pickVariant('user-42', variants);
    for (let i = 0; i < 20; i++) expect(pickVariant('user-42', variants)).toBe(first);
  });

  it('splits traffic roughly in proportion to the weights', () => {
    const counts = { A: 0, B: 0 };
    const weighted = [
      { value: 'A' as const, weight: 90 },
      { value: 'B' as const, weight: 10 },
    ];
    for (let i = 0; i < 10_000; i++) counts[pickVariant(`user-${i}`, weighted)]++;

    expect(counts.A / 10_000).toBeGreaterThan(0.87);
    expect(counts.A / 10_000).toBeLessThan(0.93);
  });

  it('never picks a zero-weight variant', () => {
    const v = [
      { value: 'A', weight: 0 },
      { value: 'B', weight: 5 },
    ];
    for (let i = 0; i < 500; i++) expect(pickVariant(`k${i}`, v)).toBe('B');
  });

  it('throws on an empty variant list', () => {
    expect(() => pickVariant('k', [])).toThrow(/at least one/);
  });
});
