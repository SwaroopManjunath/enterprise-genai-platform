import { HashingEmbedder } from '../embedding/hashing-embedder';
import { InMemorySearchIndex } from '../index/in-memory-search-index';
import { IndexingService, type UpsertDocumentInput } from '../index/indexing.service';
import { OverlapReranker } from '../rerank/overlap-reranker';
import { SearchService, type SearchRequest } from './search.service';

const options = { candidatesPerRetriever: 50, rerankCandidates: 20, rrfK: 60, minSimilarity: 0.1 };

function setup() {
  const index = new InMemorySearchIndex();
  const embedder = new HashingEmbedder(256);
  const indexing = new IndexingService(index, embedder);
  const search = new SearchService(index, embedder, new OverlapReranker(), options);
  const add = (
    tenantId: string,
    documentId: string,
    text: string,
    extra: Partial<UpsertDocumentInput> = {},
  ) => indexing.upsertDocument(tenantId, documentId, { chunks: [{ index: 0, text }], ...extra });
  return { search, add };
}

const request = (query: string, overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  query,
  topK: 5,
  mode: 'hybrid',
  rerank: true,
  ...overrides,
});
const analyst = { tenantId: 'acme', roles: ['analyst'] };
const idsOf = (hits: { documentId: string }[]) => hits.map((h) => h.documentId);

async function seeded() {
  const ctx = setup();
  await ctx.add('acme', 'refunds', 'Refunds take five working days to arrive');
  await ctx.add('acme', 'cards', 'Lost cards can be blocked in the app');
  await ctx.add('acme', 'premium', 'The premium card XK-9921 has no annual fee');
  return ctx;
}

describe('SearchService modes', () => {
  it('keyword mode finds an exact code', async () => {
    const { search } = await seeded();
    const hits = await search.search(analyst, request('XK-9921', { mode: 'keyword' }));
    expect(idsOf(hits)[0]).toBe('premium');
  });

  it('vector mode finds a word-form variant that keyword search misses', async () => {
    const { search } = await seeded();

    const keyword = await search.search(analyst, request('refunding', { mode: 'keyword' }));
    const vector = await search.search(analyst, request('refunding', { mode: 'vector' }));

    expect(keyword).toEqual([]);
    expect(idsOf(vector)[0]).toBe('refunds');
  });

  it('keeps a vector-found word-form match alive through reranking', async () => {
    const { search } = await seeded();

    const [top] = await search.search(analyst, request('refunding', { mode: 'vector' }));

    expect(top?.documentId).toBe('refunds');
    expect(top?.signals.rerankScore).toBeGreaterThan(0.9);
  });

  it('hybrid combines what each retriever finds', async () => {
    const { search } = await seeded();

    const hits = await search.search(analyst, request('refunding blocked'));

    expect(idsOf(hits)).toEqual(expect.arrayContaining(['refunds', 'cards']));
  });

  it('explains each hit with the signals that produced it', async () => {
    const { search } = await seeded();

    const [top] = await search.search(analyst, request('how long do refunds take'));

    expect(top?.documentId).toBe('refunds');
    expect(top?.signals).toMatchObject({ keywordRank: 1, vectorRank: 1 });
    expect(top?.signals.fusedScore).toBeGreaterThan(0);
    expect(top?.signals.rerankScore).toBeGreaterThan(0);
    expect(top?.score).toBe(top?.signals.rerankScore);
  });

  it('skips reranking when asked and then scores by the fused value', async () => {
    const { search } = await seeded();

    const [top] = await search.search(analyst, request('refunds', { rerank: false }));

    expect(top?.signals.rerankScore).toBeUndefined();
    expect(top?.score).toBe(top?.signals.fusedScore);
  });

  it('returns nothing for a query with no usable terms', async () => {
    const { search } = await seeded();
    expect(await search.search(analyst, request('the of and'))).toEqual([]);
  });

  it('returns nothing when the tenant has no documents', async () => {
    const { search } = setup();
    expect(await search.search(analyst, request('refunds'))).toEqual([]);
  });

  it('respects topK', async () => {
    const { search } = await seeded();
    const hits = await search.search(analyst, request('card', { topK: 1 }));
    expect(hits).toHaveLength(1);
  });
});

describe('SearchService reranking', () => {
  it('promotes a chunk that covers the whole query over one repeating a single term', async () => {
    const { search, add } = setup();
    await add('acme', 'spammy', 'refund refund refund refund refund refund');
    await add('acme', 'complete', 'Eligibility rules: the refund period is 14 days');

    const hits = await search.search(analyst, request('refund period eligibility'));

    expect(idsOf(hits)[0]).toBe('complete');
  });
});

describe('SearchService access control', () => {
  async function withRestricted() {
    const ctx = setup();
    await ctx.add('acme', 'handbook', 'Employee handbook: salary review happens yearly');
    await ctx.add('acme', 'bands', 'Confidential salary bands for managers', {
      allowedRoles: ['manager'],
    });
    await ctx.add('globex', 'other', 'Globex salary policy');
    return ctx;
  }

  it('never returns a restricted document to a caller without the role, in any mode', async () => {
    const { search } = await withRestricted();

    for (const mode of ['hybrid', 'keyword', 'vector'] as const) {
      const hits = await search.search(analyst, request('salary bands managers', { mode }));
      expect(idsOf(hits)).not.toContain('bands');
    }
  });

  it('returns it to a caller with the role', async () => {
    const { search } = await withRestricted();
    const hits = await search.search(
      { tenantId: 'acme', roles: ['manager'] },
      request('salary bands'),
    );
    expect(idsOf(hits)[0]).toBe('bands');
  });

  it('never returns another tenant’s documents', async () => {
    const { search } = await withRestricted();
    const hits = await search.search(
      { tenantId: 'acme', roles: ['manager'] },
      request('globex salary policy'),
    );
    expect(idsOf(hits)).not.toContain('other');
  });

  it('does not let hidden documents change the scores of visible ones', async () => {
    const withHidden = await withRestricted();
    const withoutHidden = setup();
    await withoutHidden.add('acme', 'handbook', 'Employee handbook: salary review happens yearly');

    const query = request('salary', { rerank: false, mode: 'keyword' });
    const [a] = await withHidden.search.search(analyst, query);
    const [b] = await withoutHidden.search.search(analyst, query);

    // Same visible corpus => identical score, so rare-term statistics cannot leak hidden content.
    expect(a?.documentId).toBe('handbook');
    expect(a?.score).toBeCloseTo(b?.score as number, 10);
  });

  it('applies the document filter within what the caller may see', async () => {
    const { search } = await withRestricted();

    const hits = await search.search(
      { tenantId: 'acme', roles: ['manager'] },
      request('salary', { filter: { documentIds: ['handbook'] } }),
    );

    expect(idsOf(hits)).toEqual(['handbook']);
  });
});
