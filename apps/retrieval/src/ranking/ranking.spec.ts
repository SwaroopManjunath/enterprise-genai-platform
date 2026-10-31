import { bm25Rank, type Bm25Document } from './bm25';
import { reciprocalRankFusion } from './rrf';
import { termFrequencies, tokenize } from '../text/tokenizer';

const doc = (id: string, text: string): Bm25Document => {
  const tokens = tokenize(text);
  return { id, termFreqs: termFrequencies(tokens), length: tokens.length };
};

describe('tokenize', () => {
  it('lowercases, strips accents and splits on punctuation', () => {
    expect(tokenize('Café-Menü 2024!')).toEqual(['cafe', 'menu', '2024']);
  });

  it('drops stopwords unless asked to keep them', () => {
    expect(tokenize('How long is the refund period')).toEqual(['long', 'refund', 'period']);
    expect(tokenize('the refund', { removeStopwords: false })).toEqual(['the', 'refund']);
  });

  it('splits identifiers into parts', () => {
    expect(tokenize('XK-9921')).toEqual(['xk', '9921']);
  });

  it('handles empty and symbol-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!! ---')).toEqual([]);
  });
});

describe('bm25Rank', () => {
  const docs = [
    doc('refunds', 'Refunds take five working days to arrive'),
    doc('cards', 'Lost cards can be blocked in the app'),
    doc('premium', 'The premium card XK 9921 has no annual fee'),
  ];

  it('ranks the document containing the query terms first', () => {
    const ranked = bm25Rank(tokenize('how long do refunds take'), docs);
    expect(ranked[0]?.id).toBe('refunds');
  });

  it('returns only documents that match something', () => {
    const ranked = bm25Rank(tokenize('refunds'), docs);
    expect(ranked.map((r) => r.id)).toEqual(['refunds']);
  });

  it('weights rare terms more than common ones', () => {
    const corpus = [
      doc('a', 'card card card card'),
      doc('b', 'card fee'),
      doc('c', 'card statement'),
      doc('d', 'zebra card'),
    ];
    const ranked = bm25Rank(tokenize('zebra card'), corpus);
    expect(ranked[0]?.id).toBe('d'); // "zebra" is rare, so it outweighs a pile of "card"
  });

  it('saturates repeated terms instead of rewarding them linearly', () => {
    const once = bm25Rank(['card'], [doc('x', 'card other words here')])[0]?.score as number;
    const many = bm25Rank(['card'], [doc('x', 'card card card card other words here')])[0]
      ?.score as number;
    expect(many).toBeGreaterThan(once);
    expect(many).toBeLessThan(once * 4);
  });

  it('prefers a shorter document with the same term count (length normalisation)', () => {
    const ranked = bm25Rank(
      ['refund'],
      [doc('short', 'refund policy'), doc('long', `refund ${'filler '.repeat(40)}`)],
    );
    expect(ranked[0]?.id).toBe('short');
  });

  it('returns nothing for an empty query or corpus', () => {
    expect(bm25Rank([], docs)).toEqual([]);
    expect(bm25Rank(['x'], [])).toEqual([]);
  });

  it('is deterministic on ties', () => {
    const tied = [doc('b', 'refund'), doc('a', 'refund')];
    expect(bm25Rank(['refund'], tied).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('reciprocalRankFusion', () => {
  it('puts documents ranked highly by several lists on top', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
    ]);
    expect(
      fused
        .map((f) => f.id)
        .slice(0, 2)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(fused[2]?.id).toBe('c');
  });

  it('keeps a document that only one list found', () => {
    const fused = reciprocalRankFusion([['a'], ['b']]);
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('records the rank in each list (undefined when absent)', () => {
    const fused = reciprocalRankFusion([['a', 'b'], ['b']]);
    expect(fused.find((f) => f.id === 'a')?.ranks).toEqual([1, undefined]);
    expect(fused.find((f) => f.id === 'b')?.ranks).toEqual([2, 1]);
  });

  it('uses 1/(k+rank) scoring', () => {
    const [only] = reciprocalRankFusion([['a']], 60);
    expect(only?.score).toBeCloseTo(1 / 61);
  });

  it('handles no input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});
