import { EmptyDocumentError, UnsupportedFileTypeError } from '../domain/errors';
import { hashDocument, normalizeAcl, type DocumentAcl, type IngestionJob } from '../domain/job';
import { InMemoryChunkIndex } from '../store/in-memory-chunk-index';
import { IngestionPipeline } from './ingestion-pipeline';

const chunking = { maxChars: 60, overlapChars: 0 };

const open: DocumentAcl = { allowedRoles: [], tags: [] };

function job(
  content: string,
  overrides: Partial<IngestionJob> & { acl?: DocumentAcl } = {},
): IngestionJob {
  const acl = overrides.acl ?? open;
  return {
    jobId: 'job-1',
    tenantId: 'acme',
    documentId: 'handbook',
    filename: 'handbook.md',
    content,
    acl,
    contentHash: hashDocument(content, acl),
    ...overrides,
  };
}

describe('IngestionPipeline', () => {
  it('chunks a document and writes it to the index with deterministic ids', async () => {
    const index = new InMemoryChunkIndex();
    const pipeline = new IngestionPipeline(index, chunking);

    const result = await pipeline.run(job('# A\nfirst section.\n\n# B\nsecond section.'));
    const chunks = await index.getChunks('acme', 'handbook');

    expect(result).toEqual({ outcome: 'indexed', chunkCount: 2 });
    expect(chunks.map((c) => c.id)).toEqual(['handbook:0', 'handbook:1']);
    expect(chunks[1]?.metadata.headingPath).toEqual(['B']);
  });

  it('skips an unchanged document without touching the index', async () => {
    const index = new InMemoryChunkIndex();
    const spy = jest.spyOn(index, 'replaceDocument');
    const pipeline = new IngestionPipeline(index, chunking);
    const same = job('# A\nbody text.');

    await pipeline.run(same);
    const second = await pipeline.run(same);

    expect(second).toEqual({ outcome: 'unchanged', chunkCount: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-ingesting an edited document replaces chunks and removes stale ones', async () => {
    const index = new InMemoryChunkIndex();
    const pipeline = new IngestionPipeline(index, chunking);

    await pipeline.run(job('# A\none.\n\n# B\ntwo.\n\n# C\nthree.'));
    expect(await index.getChunks('acme', 'handbook')).toHaveLength(3);

    const result = await pipeline.run(job('# A\none edited.'));

    expect(result.outcome).toBe('indexed');
    const chunks = await index.getChunks('acme', 'handbook');
    expect(chunks.map((c) => c.id)).toEqual(['handbook:0']);
    expect(chunks[0]?.text).toContain('one edited');
    expect((await index.getDocument('acme', 'handbook'))?.chunkCount).toBe(1);
  });

  it('is safe to retry after a failed write (no partial or duplicate state)', async () => {
    const index = new InMemoryChunkIndex();
    const real = index.replaceDocument.bind(index);
    const failOnce = jest
      .spyOn(index, 'replaceDocument')
      .mockRejectedValueOnce(new Error('search unavailable'))
      .mockImplementation(real);
    const pipeline = new IngestionPipeline(index, chunking);
    const doc = job('# A\nbody text.');

    await expect(pipeline.run(doc)).rejects.toThrow('search unavailable');
    expect(await index.getDocument('acme', 'handbook')).toBeUndefined();

    await pipeline.run(doc);
    expect(failOnce).toHaveBeenCalledTimes(2);
    expect(await index.getChunks('acme', 'handbook')).toHaveLength(1);
  });

  it('keeps tenants separate even for the same document id', async () => {
    const index = new InMemoryChunkIndex();
    const pipeline = new IngestionPipeline(index, chunking);

    await pipeline.run(job('# A\nacme text.'));
    await pipeline.run(job('# A\nglobex text.', { tenantId: 'globex' }));

    expect((await index.getChunks('acme', 'handbook'))[0]?.text).toContain('acme');
    expect((await index.getChunks('globex', 'handbook'))[0]?.text).toContain('globex');
  });

  it('raises permanent errors for unsupported and empty documents', async () => {
    const pipeline = new IngestionPipeline(new InMemoryChunkIndex(), chunking);

    await expect(pipeline.run(job('x', { filename: 'scan.pdf' }))).rejects.toBeInstanceOf(
      UnsupportedFileTypeError,
    );
    await expect(pipeline.run(job('   \n ', { filename: 'blank.txt' }))).rejects.toBeInstanceOf(
      EmptyDocumentError,
    );
  });

  it('hands the access list to the index along with the chunks', async () => {
    const index = new InMemoryChunkIndex();
    const pipeline = new IngestionPipeline(index, chunking);
    const acl = normalizeAcl({ allowedRoles: ['Manager'], tags: ['HR'] });

    await pipeline.run(job('# A\nconfidential.', { acl }));

    expect(await index.getAcl('acme', 'handbook')).toEqual({
      allowedRoles: ['manager'],
      tags: ['hr'],
    });
  });

  it('does not skip a re-upload of identical text with a tighter access list', async () => {
    const index = new InMemoryChunkIndex();
    const pipeline = new IngestionPipeline(index, chunking);
    const text = '# A\nsome policy text.';

    await pipeline.run(job(text, { acl: open }));
    const tightened = await pipeline.run(
      job(text, { acl: normalizeAcl({ allowedRoles: ['manager'] }) }),
    );

    // Same words, different audience: it must be applied, not skipped as "unchanged".
    expect(tightened.outcome).toBe('indexed');
    expect(await index.getAcl('acme', 'handbook')).toEqual({ allowedRoles: ['manager'], tags: [] });
  });
});
