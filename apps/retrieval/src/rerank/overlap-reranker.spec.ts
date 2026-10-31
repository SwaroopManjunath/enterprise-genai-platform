import { OverlapReranker } from './overlap-reranker';

const reranker = new OverlapReranker();

describe('OverlapReranker', () => {
  it('prefers a chunk covering every query term over one repeating a single term', async () => {
    const ranked = await reranker.rerank('refund period eligibility', [
      { id: 'spammy', text: 'refund refund refund refund refund' },
      { id: 'complete', text: 'Eligibility rules: the refund period is 14 days' },
    ]);

    expect(ranked[0]?.id).toBe('complete');
  });

  it('rewards a matching section heading', async () => {
    const ranked = await reranker.rerank('card fees', [
      { id: 'plain', text: 'Fees for the card are listed below.' },
      { id: 'headed', text: 'Fees for the card are listed below.', headingPath: ['Card fees'] },
    ]);

    expect(ranked[0]?.id).toBe('headed');
  });

  it('rewards query words that appear in order', async () => {
    const ranked = await reranker.rerank('blocked lost card', [
      { id: 'scattered', text: 'card issues: lost items and blocked access' },
      { id: 'ordered', text: 'a blocked lost card cannot be used' },
    ]);

    expect(ranked[0]?.id).toBe('ordered');
  });

  it('scores everything 0 when the query has no usable terms', async () => {
    const ranked = await reranker.rerank('the of', [{ id: 'a', text: 'anything' }]);
    expect(ranked).toEqual([{ id: 'a', score: 0 }]);
  });

  it('is deterministic on ties and handles an empty candidate list', async () => {
    const ranked = await reranker.rerank('refund', [
      { id: 'b', text: 'refund' },
      { id: 'a', text: 'refund' },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b']);
    expect(await reranker.rerank('refund', [])).toEqual([]);
  });
});
