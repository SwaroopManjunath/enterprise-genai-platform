import { TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { INGESTION_CONFIG, loadConfig } from '../src/config/config';
import { CHUNK_INDEX } from '../src/store/chunk-index';
import type { InMemoryChunkIndex } from '../src/store/in-memory-chunk-index';
import { IngestionWorker } from '../src/worker/ingestion-worker';

const issuer = new TestIssuer();

async function createApp(env: NodeJS.ProcessEnv = {}): Promise<INestApplication> {
  const config = loadConfig({ POLL_INTERVAL_MS: '0', CHUNK_MAX_CHARS: '200', ...env });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(issuer.verifier())
    .overrideProvider(INGESTION_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

const doc = {
  documentId: 'handbook',
  filename: 'handbook.md',
  content: '# Pricing\nPlans start at ten euros.\n\n# Support\nCall us any time.',
};

describe('ingestion API', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app.close();
  });

  /** A caller authenticated with a signed token. Defaults to a document and ingestion admin. */
  const as = (tenant: string, roles: string[] = ['document-admin', 'ingestion-admin']) => {
    const bearer = `Bearer ${issuer.mint({ tenant, roles })}`;
    return {
      get: (path: string) => request(app.getHttpServer()).get(path).set('authorization', bearer),
      post: (path: string, body: object = {}) =>
        request(app.getHttpServer()).post(path).set('authorization', bearer).send(body),
    };
  };
  const index = () => app.get<InMemoryChunkIndex>(CHUNK_INDEX);

  it('accepts a document (202), processes it in the background, and indexes the chunks', async () => {
    app = await createApp();
    const acme = as('acme');

    const accepted = await acme.post('/v1/documents', doc).expect(202);
    expect(accepted.body.status).toBe('queued');
    const jobId = accepted.body.jobId as string;
    expect((await acme.get(`/v1/ingestions/${jobId}`).expect(200)).body.status).toBe('queued');

    await app.get(IngestionWorker).drain();

    expect((await acme.get(`/v1/ingestions/${jobId}`).expect(200)).body).toMatchObject({
      status: 'succeeded',
      chunkCount: 2,
    });
    expect((await acme.get('/v1/documents/handbook').expect(200)).body.chunkCount).toBe(2);
    const chunks = await index().getChunks('acme', 'handbook');
    expect(chunks.map((c) => c.metadata.headingPath)).toEqual([['Pricing'], ['Support']]);
  });

  it('carries the access list from the upload to the index, normalised', async () => {
    app = await createApp();
    await as('acme').post('/v1/documents', {
      ...doc,
      allowedRoles: [' Manager ', 'manager', 'CFO'],
      tags: ['HR'],
    });

    await app.get(IngestionWorker).drain();

    expect(await index().getAcl('acme', 'handbook')).toEqual({
      allowedRoles: ['cfo', 'manager'],
      tags: ['hr'],
    });
  });

  it('is idempotent: resubmitting is unchanged, an edit replaces stale chunks, tighter access is applied', async () => {
    app = await createApp();
    const acme = as('acme');
    const worker = app.get(IngestionWorker);

    await acme.post('/v1/documents', doc);
    await worker.drain();

    const again = await acme.post('/v1/documents', doc).expect(202);
    await worker.drain();
    expect((await acme.get(`/v1/ingestions/${again.body.jobId}`)).body.status).toBe('unchanged');

    await acme.post('/v1/documents', { ...doc, content: '# Pricing\nNow free.' });
    await worker.drain();
    const chunks = await index().getChunks('acme', 'handbook');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('Now free');

    // Same text, but now restricted: must not be skipped as unchanged.
    const restricted = await acme
      .post('/v1/documents', { ...doc, content: '# Pricing\nNow free.', allowedRoles: ['manager'] })
      .expect(202);
    await worker.drain();
    expect((await acme.get(`/v1/ingestions/${restricted.body.jobId}`)).body.status).toBe(
      'succeeded',
    );
    expect(await index().getAcl('acme', 'handbook')).toEqual({
      allowedRoles: ['manager'],
      tags: [],
    });
  });

  it('dead-letters an unsupported file, lists it, and can requeue it', async () => {
    app = await createApp();
    const acme = as('acme');
    const accepted = await acme.post('/v1/documents', {
      documentId: 'scan',
      filename: 'scan.pdf',
      content: 'not really a pdf',
    });
    const jobId = accepted.body.jobId as string;

    await app.get(IngestionWorker).drain();

    expect((await acme.get(`/v1/ingestions/${jobId}`)).body).toMatchObject({ status: 'failed' });
    const dead = (await acme.get('/v1/dead-letters').expect(200)).body.deadLetters;
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ jobId, filename: 'scan.pdf', deliveryCount: 1 });
    expect(dead[0].reason).toMatch(/Unsupported file type/);

    const requeued = await acme.post(`/v1/dead-letters/${jobId}/requeue`).expect(202);
    expect(requeued.body.status).toBe('queued');
    expect((await acme.get('/v1/dead-letters')).body.deadLetters).toEqual([]);
  });

  it('isolates tenants across jobs, documents and dead letters', async () => {
    app = await createApp();
    const accepted = await as('acme').post('/v1/documents', doc);
    await as('acme').post('/v1/documents', { documentId: 'x', filename: 'x.pdf', content: 'x' });
    await app.get(IngestionWorker).drain();

    const globex = as('globex');
    expect(
      (await globex.get(`/v1/ingestions/${accepted.body.jobId}`).expect(404)).body.error.code,
    ).toBe('job_not_found');
    expect((await globex.get('/v1/documents/handbook').expect(404)).body.error.code).toBe(
      'document_not_found',
    );
    expect((await globex.get('/v1/dead-letters').expect(200)).body.deadLetters).toEqual([]);
  });

  it('validates input', async () => {
    app = await createApp({ MAX_DOCUMENT_BYTES: '50' });
    const acme = as('acme');

    const bad = await acme.post('/v1/documents', { ...doc, documentId: 'has space' }).expect(400);
    expect(bad.body.error.code).toBe('invalid_request');
    await acme.post('/v1/documents', { ...doc, allowedRoles: 'manager' }).expect(400);
    await acme.post('/v1/documents', { ...doc, allowedRoles: Array(21).fill('r') }).expect(400);

    const big = await acme.post('/v1/documents', { ...doc, content: 'x'.repeat(51) }).expect(413);
    expect(big.body.error).toMatchObject({ code: 'document_too_large', maxBytes: 50 });
  });

  describe('authentication and authorization', () => {
    it('requires a valid token, and takes the tenant from it rather than from a header', async () => {
      app = await createApp();
      const accepted = await as('acme').post('/v1/documents', doc).expect(202);

      await request(app.getHttpServer()).get('/v1/dead-letters').expect(401);
      await request(app.getHttpServer())
        .post('/v1/documents')
        .set('authorization', `Bearer ${issuer.mint({ tenant: 'acme', expiresInSec: -999 })}`)
        .send(doc)
        .expect(401);
      await request(app.getHttpServer())
        .post('/v1/documents')
        .set('authorization', `Bearer ${issuer.mint({ tenant: 'Not A Tenant!' })}`)
        .send(doc)
        .expect(401);

      // Spoof attempt: globex's token plus an x-tenant-id naming acme still cannot see acme's job.
      await request(app.getHttpServer())
        .get(`/v1/ingestions/${accepted.body.jobId}`)
        .set(
          'authorization',
          `Bearer ${issuer.mint({ tenant: 'globex', roles: ['document-admin'] })}`,
        )
        .set('x-tenant-id', 'acme')
        .expect(404);
    });

    it('lets only document-admins upload or inspect uploads: ordinary members get 403', async () => {
      app = await createApp();
      const accepted = await as('acme').post('/v1/documents', doc).expect(202);
      const member = as('acme', ['analyst', 'manager']);

      expect((await member.post('/v1/documents', doc).expect(403)).body.error.code).toBe(
        'forbidden',
      );
      await member.get(`/v1/ingestions/${accepted.body.jobId}`).expect(403);
      await member.get('/v1/documents/handbook').expect(403);
    });

    it('keeps dead-letter operations to ingestion-admins, separate from document-admins', async () => {
      app = await createApp();
      const uploader = as('acme', ['document-admin']);

      await uploader.post('/v1/documents', doc).expect(202);
      await uploader.get('/v1/dead-letters').expect(403);
      await uploader.post('/v1/dead-letters/some-job/requeue').expect(403);
    });

    it('has no endpoint that returns document content: only retrieval serves it, trimmed by role', async () => {
      app = await createApp();
      const admin = as('acme');
      await admin.post('/v1/documents', { ...doc, allowedRoles: ['manager'] });
      await app.get(IngestionWorker).drain();

      await admin.get('/v1/documents/handbook/chunks').expect(404);
      const info = (await admin.get('/v1/documents/handbook').expect(200)).body;
      expect(JSON.stringify(info)).not.toContain('Plans start');
    });
  });

  it('processes documents automatically when the background poller is enabled', async () => {
    app = await createApp({ POLL_INTERVAL_MS: '20' });
    const acme = as('acme');
    const accepted = await acme.post('/v1/documents', doc).expect(202);

    let status = 'queued';
    for (let i = 0; i < 50 && status !== 'succeeded'; i++) {
      await new Promise((r) => setTimeout(r, 40));
      status = (await acme.get(`/v1/ingestions/${accepted.body.jobId}`)).body.status;
    }

    expect(status).toBe('succeeded');
  });
});
