import type { Source } from '../ask/sources';
import { sourcesFingerprint } from './fingerprint';

const source = (chunkId: string, text: string, marker = 1): Source => ({
  marker,
  documentId: chunkId.split(':')[0] as string,
  chunkId,
  headingPath: [],
  text,
  score: 1,
});
const extras = { guardrailsMode: 'enforce', epoch: '1' };
const registry = { name: 'rag-answer', version: 2, source: 'registry' as const };
const builtin = { name: 'rag-answer', version: 'builtin' as const, source: 'builtin' as const };

describe('sourcesFingerprint', () => {
  const base = [
    source('handbook:0', 'Refunds take five days.'),
    source('faq:1', 'Cards can be blocked.', 2),
  ];

  it('is the same for the same sources, prompt and settings', () => {
    expect(sourcesFingerprint(base, registry, extras)).toBe(
      sourcesFingerprint(base, registry, extras),
    );
  });

  it('changes when a user is shown fewer sources (a restricted document they cannot read)', () => {
    const withRestricted = [...base, source('salary:0', 'Bands start at M1.', 3)];

    expect(sourcesFingerprint(withRestricted, registry, extras)).not.toBe(
      sourcesFingerprint(base, registry, extras),
    );
  });

  it('changes when a document is edited, even though its id is the same', () => {
    const edited = [source('handbook:0', 'Refunds take TEN days.'), base[1] as Source];

    expect(sourcesFingerprint(edited, registry, extras)).not.toBe(
      sourcesFingerprint(base, registry, extras),
    );
  });

  it('changes with the order of the sources, because the answer cites them by position', () => {
    const swapped = [
      source('faq:1', 'Cards can be blocked.', 1),
      source('handbook:0', 'Refunds take five days.', 2),
    ];

    expect(sourcesFingerprint(swapped, registry, extras)).not.toBe(
      sourcesFingerprint(base, registry, extras),
    );
  });

  it('changes with the prompt version, including which A/B variant a user got', () => {
    expect(sourcesFingerprint(base, { ...registry, version: 3 }, extras)).not.toBe(
      sourcesFingerprint(base, registry, extras),
    );
    expect(sourcesFingerprint(base, builtin, extras)).not.toBe(
      sourcesFingerprint(base, registry, extras),
    );
  });

  it('changes with the guardrail mode and the cache epoch (the manual way to drop everything)', () => {
    const f = sourcesFingerprint(base, registry, extras);

    expect(sourcesFingerprint(base, registry, { ...extras, guardrailsMode: 'monitor' })).not.toBe(
      f,
    );
    expect(sourcesFingerprint(base, registry, { ...extras, epoch: '2' })).not.toBe(f);
  });

  it('does not depend on scores or headings, which do not change what the model reads', () => {
    const rescored = base.map((s) => ({ ...s, score: 99 }));

    expect(sourcesFingerprint(rescored, registry, extras)).toBe(
      sourcesFingerprint(base, registry, extras),
    );
  });
});
