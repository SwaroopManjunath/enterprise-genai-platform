import { cosineSimilarity } from './embedder';
import { HashingEmbedder } from './hashing-embedder';

const embedder = new HashingEmbedder(256);
const sim = async (a: string, b: string): Promise<number> => {
  const [va, vb] = await embedder.embed([a, b]);
  return cosineSimilarity(va as number[], vb as number[]);
};

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('is 0 when a vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('HashingEmbedder', () => {
  it('is deterministic and unit length', async () => {
    const [first] = await embedder.embed(['refunds take five days']);
    const [second] = await embedder.embed(['refunds take five days']);

    expect(first).toEqual(second);
    expect(first).toHaveLength(256);
    const length = Math.sqrt((first as number[]).reduce((s, v) => s + v * v, 0));
    expect(length).toBeCloseTo(1);
  });

  it('treats word forms as similar even though keywords differ', async () => {
    expect(await sim('refunding', 'refunds')).toBeGreaterThan(0.4);
  });

  it('scores related texts above unrelated ones', async () => {
    const related = await sim('how long do refunds take', 'Refunds take five working days');
    const unrelated = await sim('how long do refunds take', 'Lost cards can be blocked in the app');

    expect(related).toBeGreaterThan(unrelated);
    expect(related).toBeGreaterThan(0.3);
    expect(unrelated).toBeLessThan(0.15);
  });

  it('returns a zero vector for text with no tokens', async () => {
    const [vector] = await embedder.embed(['!!! the of']);
    expect((vector as number[]).every((v) => v === 0)).toBe(true);
  });

  it('does not capture meaning (documented limitation)', async () => {
    expect(await sim('reimbursement', 'refund')).toBeLessThan(0.15);
  });
});
