import { digest, fingerprint, stableStringify } from './stable-json';

describe('stable-json', () => {
  it('ignores key order at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(
      stableStringify({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('keeps array order and distinguishes values', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }));
    expect(stableStringify(undefined)).toBe('null');
  });

  it('fingerprints fully, and digests a short prefix of the same thing', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(digest({ a: 1 })).toBe(fingerprint({ a: 1 }).slice(0, 16));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
