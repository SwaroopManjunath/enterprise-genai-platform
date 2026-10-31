import type { AppTokenClient } from '@genai/auth';
import { DownstreamError, HttpJsonClient } from '@genai/shared';
import { PermanentIngestionError } from '../domain/errors';
import { hashDocument, normalizeAcl, type IngestionJob } from '../domain/job';
import { IngestionPipeline } from '../pipeline/ingestion-pipeline';
import { InMemoryQueue } from '../queue/in-memory-queue';
import { InMemoryJobStore } from '../store/job-store';
import { IngestionWorker } from '../worker/ingestion-worker';
import { RetrievalChunkIndex } from './retrieval-chunk-index';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const hash = 'd'.repeat(64);
const chunks = [
  {
    index: 0,
    text: 'Refunds take five days.',
    id: 'doc:0',
    metadata: { headingPath: ['Refunds'] },
  },
];
const acl = normalizeAcl({ allowedRoles: ['Manager'], tags: ['hr'] });

function setup(fetchImpl: jest.Mock) {
  const tokens: AppTokenClient & { getToken: jest.Mock } = {
    getToken: jest.fn().mockResolvedValue('service-token'),
  };
  const http = new HttpJsonClient({
    service: 'retrieval',
    baseUrl: 'http://rt.test',
    timeoutMs: 1000,
    fetchImpl,
  });
  return { index: new RetrievalChunkIndex(http, tokens, 'api://retrieval/.default'), tokens };
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error,
  );

describe('RetrievalChunkIndex', () => {
  it('writes the document for the named tenant, with its access list and hash, as the service', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ documentId: 'doc', chunkCount: 1 }));
    const { index, tokens } = setup(fetchImpl);

    await index.replaceDocument('acme-bank', 'doc', hash, chunks, acl);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://rt.test/v1/tenants/acme-bank/index/documents/doc');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer service-token');
    expect(JSON.parse(init.body as string)).toEqual({
      chunks: [
        { index: 0, text: 'Refunds take five days.', metadata: { headingPath: ['Refunds'] } },
      ],
      allowedRoles: ['manager'],
      tags: ['hr'],
      contentHash: hash,
    });
    expect(tokens.getToken).toHaveBeenCalledWith('api://retrieval/.default');
  });

  it('encodes ids so they cannot alter the request path', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({}));
    await setup(fetchImpl).index.replaceDocument('acme', 'a/../b?x=1', hash, chunks, acl);

    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
      'http://rt.test/v1/tenants/acme/index/documents/a%2F..%2Fb%3Fx%3D1',
    );
  });

  describe('getDocument', () => {
    it('returns the stored hash and chunk count', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          json({ documentId: 'doc', contentHash: hash, chunkCount: 3, indexedAt: 'now' }),
        );

      expect(await setup(fetchImpl).index.getDocument('acme', 'doc')).toEqual({
        documentId: 'doc',
        contentHash: hash,
        chunkCount: 3,
        indexedAt: 'now',
      });
    });

    it('treats 404 as not indexed, and an entry without a hash as not provably unchanged', async () => {
      expect(
        await setup(jest.fn().mockResolvedValue(json({}, 404))).index.getDocument('a', 'd'),
      ).toBeUndefined();
      const noHash = jest
        .fn()
        .mockResolvedValue(json({ documentId: 'd', chunkCount: 1, indexedAt: 'x' }));
      expect(await setup(noHash).index.getDocument('a', 'd')).toBeUndefined();
    });

    it('lets other failures through to be retried', async () => {
      const error = await rejection(
        setup(jest.fn().mockResolvedValue(json({}, 503))).index.getDocument('a', 'd'),
      );
      expect(error).toBeInstanceOf(DownstreamError);
    });
  });

  describe('error classification (drives retry versus dead-letter)', () => {
    it.each([400, 413])(
      'HTTP %i from the index is permanent: the document cannot ever be indexed',
      async (status) => {
        const { index } = setup(
          jest.fn().mockResolvedValue(json({ error: { code: 'invalid_request' } }, status)),
        );
        const error = await rejection(index.replaceDocument('acme', 'doc', hash, chunks, acl));

        expect(error).toBeInstanceOf(PermanentIngestionError);
        expect((error as Error).message).toMatch(/search index rejected this document/);
      },
    );

    it.each([
      ['503', () => jest.fn().mockResolvedValue(json({}, 503))],
      ['429', () => jest.fn().mockResolvedValue(json({}, 429))],
      ['401 (our credentials)', () => jest.fn().mockResolvedValue(json({}, 401))],
      ['403', () => jest.fn().mockResolvedValue(json({}, 403))],
      ['unreachable', () => jest.fn().mockRejectedValue(new TypeError('fetch failed'))],
    ])('%s is transient: it may succeed later', async (_label, makeFetch) => {
      const error = await rejection(
        setup(makeFetch()).index.replaceDocument('acme', 'doc', hash, chunks, acl),
      );

      expect(error).toBeInstanceOf(DownstreamError);
      expect(error).not.toBeInstanceOf(PermanentIngestionError);
    });
  });

  describe('inside the worker', () => {
    function workerWith(fetchImpl: jest.Mock) {
      const clock = { now: 0 };
      const queue = new InMemoryQueue<IngestionJob>({
        maxDeliveries: 3,
        visibilityTimeoutMs: 1000,
        now: () => clock.now,
      });
      const jobs = new InMemoryJobStore();
      const { index } = setup(fetchImpl);
      const worker = new IngestionWorker(
        queue,
        new IngestionPipeline(index, { maxChars: 200, overlapChars: 0 }),
        jobs,
        {
          maxDeliveries: 3,
          retry: { baseDelayMs: 100, maxDelayMs: 1000 },
          random: () => 0.99,
        },
      );
      const submit = async (content: string) => {
        const job: IngestionJob = {
          jobId: 'job-1',
          tenantId: 'acme-bank',
          documentId: 'doc',
          filename: 'doc.md',
          content,
          acl,
          contentHash: hashDocument(content, acl),
        };
        const at = new Date().toISOString();
        await jobs.create({
          jobId: 'job-1',
          tenantId: 'acme-bank',
          documentId: 'doc',
          status: 'queued',
          attempts: 0,
          createdAt: at,
          updatedAt: at,
        });
        await queue.enqueue(job);
      };
      return { worker, queue, jobs, clock, submit };
    }

    it('retries when the index is briefly down, then indexes the document', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(json({}, 404)) // getDocument: not indexed yet
        .mockResolvedValueOnce(json({}, 503)) // replaceDocument: index is down
        .mockResolvedValueOnce(json({}, 404)) // retry: getDocument
        .mockResolvedValueOnce(json({ documentId: 'doc', chunkCount: 1 })); // retry: replaceDocument ok
      const { worker, jobs, clock, submit } = workerWith(fetchImpl);
      await submit('# Refunds\nFive days.');

      await worker.processOnce();
      expect(await jobs.get('acme-bank', 'job-1')).toMatchObject({
        status: 'queued',
        error: expect.stringContaining('503'),
      });

      clock.now += 1000;
      await worker.processOnce();
      expect(await jobs.get('acme-bank', 'job-1')).toMatchObject({
        status: 'succeeded',
        attempts: 2,
      });
    });

    it('dead-letters at once when the index rejects the document as invalid', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(json({}, 404))
        .mockResolvedValueOnce(json({ error: { code: 'invalid_request' } }, 400));
      const { worker, jobs, queue, submit } = workerWith(fetchImpl);
      await submit('# Refunds\nFive days.');

      await worker.drain();

      expect(await jobs.get('acme-bank', 'job-1')).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await queue.deadLetters())[0]?.reason).toMatch(/search index rejected/);
    });

    it('skips the write entirely when the index already holds the same content and access list', async () => {
      const content = '# Refunds\nFive days.';
      const fetchImpl = jest.fn().mockResolvedValue(
        json({
          documentId: 'doc',
          contentHash: hashDocument(content, acl),
          chunkCount: 1,
          indexedAt: 'x',
        }),
      );
      const { worker, jobs, submit } = workerWith(fetchImpl);
      await submit(content);

      await worker.drain();

      expect((await jobs.get('acme-bank', 'job-1'))?.status).toBe('unchanged');
      expect(fetchImpl).toHaveBeenCalledTimes(1); // only the lookup, no PUT
    });
  });
});
