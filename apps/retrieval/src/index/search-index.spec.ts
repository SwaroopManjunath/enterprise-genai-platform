import { HashingEmbedder } from '../embedding/hashing-embedder';
import { InMemorySearchIndex } from './in-memory-search-index';
import { IndexingService } from './indexing.service';

function setup() {
  const index = new InMemorySearchIndex();
  const indexing = new IndexingService(index, new HashingEmbedder(64));
  return { index, indexing };
}

const ids = async (
  index: InMemorySearchIndex,
  tenantId: string,
  roles: string[],
  filter?: Parameters<InMemorySearchIndex['candidates']>[1],
) => (await index.candidates({ tenantId, roles }, filter)).map((c) => c.chunkId).sort();

describe('IndexingService', () => {
  it('stores chunks with deterministic ids, token stats and a vector', async () => {
    const { index, indexing } = setup();

    const result = await indexing.upsertDocument('acme', 'faq', {
      chunks: [
        {
          index: 0,
          text: 'Refunds take five working days',
          metadata: { headingPath: ['Refunds'] },
        },
      ],
    });
    const [chunk] = await index.candidates({ tenantId: 'acme', roles: [] });

    expect(result).toEqual({ documentId: 'faq', chunkCount: 1 });
    expect(chunk?.chunkId).toBe('faq:0');
    expect(chunk?.termFreqs.get('refunds')).toBe(1);
    expect(chunk?.length).toBe(5); // refunds, take, five, working, days
    expect(chunk?.vector).toHaveLength(64);
    expect(chunk?.metadata).toEqual({ headingPath: ['Refunds'] });
  });

  it('replaces a document so stale chunks disappear', async () => {
    const { index, indexing } = setup();
    await indexing.upsertDocument('acme', 'faq', {
      chunks: [
        { index: 0, text: 'one' },
        { index: 1, text: 'two' },
        { index: 2, text: 'three' },
      ],
    });

    await indexing.upsertDocument('acme', 'faq', { chunks: [{ index: 0, text: 'one edited' }] });

    expect(await ids(index, 'acme', [])).toEqual(['faq:0']);
  });

  it('normalises roles and tags (trim, lowercase, dedupe)', async () => {
    const { index, indexing } = setup();
    await indexing.upsertDocument('acme', 'doc', {
      chunks: [{ index: 0, text: 'secret' }],
      allowedRoles: [' Manager ', 'manager', ''],
    });

    expect(await ids(index, 'acme', ['manager'])).toEqual(['doc:0']);
  });
});

describe('SearchIndex access trimming', () => {
  async function seeded() {
    const ctx = setup();
    await ctx.indexing.upsertDocument('acme', 'public', {
      chunks: [{ index: 0, text: 'open handbook' }],
      tags: ['hr'],
    });
    await ctx.indexing.upsertDocument('acme', 'managers', {
      chunks: [{ index: 0, text: 'salary bands' }],
      allowedRoles: ['manager'],
      tags: ['hr', 'confidential'],
    });
    await ctx.indexing.upsertDocument('acme', 'finance', {
      chunks: [{ index: 0, text: 'budget' }],
      allowedRoles: ['finance', 'cfo'],
    });
    await ctx.indexing.upsertDocument('globex', 'public', {
      chunks: [{ index: 0, text: 'globex handbook' }],
    });
    return ctx;
  }

  it('shows open documents to every member of the tenant, and nothing restricted', async () => {
    const { index } = await seeded();
    expect(await ids(index, 'acme', [])).toEqual(['public:0']);
    expect(await ids(index, 'acme', ['analyst'])).toEqual(['public:0']);
  });

  it('reveals a restricted document only to a matching role', async () => {
    const { index } = await seeded();
    expect(await ids(index, 'acme', ['manager'])).toEqual(['managers:0', 'public:0']);
    expect(await ids(index, 'acme', ['cfo'])).toEqual(['finance:0', 'public:0']);
    expect(await ids(index, 'acme', ['manager', 'finance'])).toEqual([
      'finance:0',
      'managers:0',
      'public:0',
    ]);
  });

  it('never crosses tenants, even for an identical document id', async () => {
    const { index } = await seeded();
    const globex = await index.candidates({ tenantId: 'globex', roles: ['manager', 'cfo'] });

    expect(globex.map((c) => c.text)).toEqual(['globex handbook']);
    expect(await ids(index, 'unknown-tenant', ['manager'])).toEqual([]);
  });

  it('applies filters on top of access, never instead of it', async () => {
    const { index } = await seeded();
    expect(await ids(index, 'acme', ['manager'], { tags: ['confidential'] })).toEqual([
      'managers:0',
    ]);
    expect(await ids(index, 'acme', ['analyst'], { tags: ['confidential'] })).toEqual([]);
    expect(await ids(index, 'acme', ['manager'], { documentIds: ['public'] })).toEqual([
      'public:0',
    ]);
    expect(await ids(index, 'acme', ['analyst'], { documentIds: ['managers'] })).toEqual([]);
  });

  it('removes a deleted document', async () => {
    const { index, indexing } = await seeded();

    expect(await indexing.deleteDocument('acme', 'public')).toBe(true);
    expect(await indexing.deleteDocument('acme', 'public')).toBe(false);
    expect(await ids(index, 'acme', ['manager'])).toEqual(['managers:0']);
  });
});

describe('document info and content hash', () => {
  const hash = 'b'.repeat(64);

  it('records the hash and chunk count, and updates them when the document is replaced', async () => {
    const { indexing } = setup();

    await indexing.upsertDocument('acme', 'doc', {
      chunks: [
        { index: 0, text: 'one' },
        { index: 1, text: 'two' },
      ],
      contentHash: hash,
    });
    expect(await indexing.getDocument('acme', 'doc')).toMatchObject({
      documentId: 'doc',
      contentHash: hash,
      chunkCount: 2,
    });

    await indexing.upsertDocument('acme', 'doc', {
      chunks: [{ index: 0, text: 'one' }],
      contentHash: 'c'.repeat(64),
    });
    expect(await indexing.getDocument('acme', 'doc')).toMatchObject({
      contentHash: 'c'.repeat(64),
      chunkCount: 1,
    });
  });

  it('has no hash when none was given, and nothing once deleted', async () => {
    const { indexing } = setup();
    await indexing.upsertDocument('acme', 'doc', { chunks: [{ index: 0, text: 'x' }] });

    expect(await indexing.getDocument('acme', 'doc')).not.toHaveProperty('contentHash');
    await indexing.deleteDocument('acme', 'doc');
    expect(await indexing.getDocument('acme', 'doc')).toBeUndefined();
  });

  it('does not show one tenant the bookkeeping of another', async () => {
    const { indexing } = setup();
    await indexing.upsertDocument('acme', 'doc', {
      chunks: [{ index: 0, text: 'x' }],
      contentHash: hash,
    });

    expect(await indexing.getDocument('globex', 'doc')).toBeUndefined();
  });
});
