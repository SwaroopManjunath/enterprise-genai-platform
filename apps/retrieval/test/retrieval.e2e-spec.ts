import { TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const issuer = new TestIssuer();

describe('retrieval API', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(issuer.verifier())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  /** A caller authenticated with a signed token carrying exactly these roles. */
  const as = (tenant: string, roles: string[] = []) => {
    const bearer = `Bearer ${issuer.mint({ tenant, roles })}`;
    const http = () => request(app.getHttpServer());
    return {
      put: (path: string, body: object) => http().put(path).set('authorization', bearer).send(body),
      get: (path: string) => http().get(path).set('authorization', bearer),
      del: (path: string) => http().delete(path).set('authorization', bearer),
      search: (body: object) => http().post('/v1/search').set('authorization', bearer).send(body),
    };
  };
  const indexer = (tenant: string) => as(tenant, ['indexer']);

  const seed = async () => {
    const admin = indexer('acme');
    await admin.put('/v1/tenants/acme/index/documents/faq', {
      chunks: [
        {
          index: 0,
          text: '# Refunds\nRefunds take five working days.',
          metadata: { headingPath: ['Refunds'] },
        },
        {
          index: 1,
          text: '# Cards\nLost cards can be blocked in the app.',
          metadata: { headingPath: ['Cards'] },
        },
      ],
      tags: ['support'],
    });
    await admin.put('/v1/tenants/acme/index/documents/salary', {
      chunks: [{ index: 0, text: 'Confidential salary bands for managers' }],
      allowedRoles: ['Manager'],
    });
  };

  const documentsOf = (res: request.Response): string[] =>
    res.body.results.map((r: { documentId: string }) => r.documentId);

  it('indexes documents and answers a hybrid search with explainable signals', async () => {
    await seed();

    const res = await as('acme', ['analyst'])
      .search({ query: 'how long do refunds take' })
      .expect(200);

    expect(res.body).toMatchObject({ mode: 'hybrid', count: expect.any(Number) });
    const top = res.body.results[0];
    expect(top).toMatchObject({
      chunkId: 'faq:0',
      documentId: 'faq',
      metadata: { headingPath: ['Refunds'] },
    });
    expect(top.signals.keywordRank).toBe(1);
    expect(top.signals.vectorRank).toBe(1);
    expect(top.signals.rerankScore).toBeGreaterThan(0);
  });

  it('hides restricted documents from callers without the role and shows them to those with it', async () => {
    await seed();
    const query = { query: 'salary bands managers' };

    const analyst = await as('acme', ['analyst']).search(query).expect(200);
    const manager = await as('acme', ['Manager']).search(query).expect(200);
    const nobody = await as('acme').search(query).expect(200);

    expect(documentsOf(analyst)).not.toContain('salary');
    expect(documentsOf(nobody)).not.toContain('salary');
    expect(manager.body.results[0].documentId).toBe('salary');
  });

  it('cannot be talked into a wider view: a spoofed x-roles or x-tenant-id header is ignored', async () => {
    await seed();

    const res = await request(app.getHttpServer())
      .post('/v1/search')
      .set('authorization', `Bearer ${issuer.mint({ tenant: 'acme', roles: ['analyst'] })}`)
      .set('x-roles', 'manager')
      .send({ query: 'salary bands managers' })
      .expect(200);
    expect(documentsOf(res)).not.toContain('salary');

    const otherTenant = await request(app.getHttpServer())
      .post('/v1/search')
      .set('authorization', `Bearer ${issuer.mint({ tenant: 'globex', roles: ['manager'] })}`)
      .set('x-tenant-id', 'acme')
      .send({ query: 'refunds salary' })
      .expect(200);
    expect(otherTenant.body.results).toEqual([]);
  });

  it('isolates tenants', async () => {
    await seed();
    const res = await as('globex', ['manager']).search({ query: 'refunds salary' }).expect(200);
    expect(res.body.results).toEqual([]);
  });

  it('supports keyword and vector modes, filters and topK', async () => {
    await seed();
    const acme = as('acme', ['manager']);

    expect((await acme.search({ query: 'refunding', mode: 'keyword' })).body.count).toBe(0);
    expect(
      (await acme.search({ query: 'refunding', mode: 'vector' })).body.results[0].chunkId,
    ).toBe('faq:0');

    const tagged = await acme.search({
      query: 'salary refunds cards',
      filter: { tags: ['support'] },
    });
    expect(documentsOf(tagged).every((id) => id === 'faq')).toBe(true);

    expect((await acme.search({ query: 'cards refunds', topK: 1 })).body.results).toHaveLength(1);
  });

  it('re-indexing replaces a document and removes stale chunks; delete removes it', async () => {
    await seed();
    const acme = as('acme', ['analyst', 'indexer']);

    await acme.put('/v1/tenants/acme/index/documents/faq', {
      chunks: [{ index: 0, text: 'Refunds are now instant' }],
    });
    const after = await acme.search({ query: 'cards blocked' });
    expect(after.body.results.map((r: { chunkId: string }) => r.chunkId)).not.toContain('faq:1');

    await acme.del('/v1/tenants/acme/index/documents/faq').expect(200);
    await acme.del('/v1/tenants/acme/index/documents/faq').expect(404);
    expect((await acme.search({ query: 'refunds instant' })).body.results).toEqual([]);
  });

  it('requires the indexer role to change the index, and a valid token for anything', async () => {
    await seed();
    const user = as('acme', ['analyst', 'manager']);
    const chunks = [{ index: 0, text: 'planted content' }];

    expect(
      (await user.put('/v1/tenants/acme/index/documents/planted', { chunks }).expect(403)).body
        .error.code,
    ).toBe('forbidden');
    await user.del('/v1/tenants/acme/index/documents/faq').expect(403);
    // Nothing changed: the document is still searchable and the planted one does not exist.
    expect(documentsOf(await user.search({ query: 'refunds' }))).toContain('faq');
    expect(documentsOf(await user.search({ query: 'planted content' }))).not.toContain('planted');

    await request(app.getHttpServer()).post('/v1/search').send({ query: 'refunds' }).expect(401);
    await request(app.getHttpServer())
      .post('/v1/search')
      .set('authorization', `Bearer ${issuer.mint({ tenant: 'acme', expiresInSec: -999 })}`)
      .send({ query: 'refunds' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/search')
      .set('authorization', `Bearer ${issuer.mint({ tenant: 'Not A Tenant!' })}`)
      .send({ query: 'refunds' })
      .expect(401);
  });

  it('lets the indexer service act for a named tenant, whatever its own token says', async () => {
    // The service token carries the platform's tenant, not a customer's; the path names the tenant.
    const service = as('platform-services', ['indexer']);
    await service
      .put('/v1/tenants/globex/index/documents/handbook', {
        chunks: [{ index: 0, text: 'Globex refunds take ten working days.' }],
      })
      .expect(200);

    const globex = await as('globex', ['analyst']).search({ query: 'refunds take' }).expect(200);
    const acme = await as('acme', ['analyst']).search({ query: 'refunds take' }).expect(200);

    expect(documentsOf(globex)).toEqual(['handbook']);
    expect(documentsOf(acme)).not.toContain('handbook');
  });

  it('remembers the content hash, so the writer can tell an unchanged re-upload', async () => {
    const indexerCaller = as('platform-services', ['indexer']);
    const hash = 'a'.repeat(64);
    const path = '/v1/tenants/acme/index/documents/policy';

    await indexerCaller.get(path).expect(404);
    await indexerCaller.put(path, {
      chunks: [{ index: 0, text: 'policy text' }],
      contentHash: hash,
    });

    const info = (await indexerCaller.get(path).expect(200)).body;
    expect(info).toMatchObject({ documentId: 'policy', contentHash: hash, chunkCount: 1 });
    expect(Date.parse(info.indexedAt)).not.toBeNaN();
  });

  it('keeps index bookkeeping from end users: document info needs the indexer role', async () => {
    await seed();
    const manager = as('acme', ['manager']);

    await manager.get('/v1/tenants/acme/index/documents/salary').expect(403);
    await manager.get('/v1/tenants/acme/index/documents/faq').expect(403);
  });

  it('rejects an invalid tenant or document id in the path, and the old tenant-less routes are gone', async () => {
    const service = as('platform-services', ['indexer']);
    const chunks = [{ index: 0, text: 'x' }];

    expect(
      (await service.put('/v1/tenants/Not%20A%20Tenant/index/documents/d', { chunks }).expect(400))
        .body.error.code,
    ).toBe('invalid_tenant');
    expect(
      (await service.put('/v1/tenants/acme/index/documents/bad%20id', { chunks }).expect(400)).body
        .error.code,
    ).toBe('invalid_request');
    expect(
      (
        await service
          .put('/v1/tenants/acme/index/documents/d', { chunks, contentHash: 'NOT-HEX' })
          .expect(400)
      ).body.error.code,
    ).toBe('invalid_request');
    await service.put('/v1/index/documents/d', { chunks }).expect(404);
  });

  it('validates input', async () => {
    const acme = as('acme', ['indexer']);
    const code = async (r: request.Test, status: number) =>
      (await r.expect(status)).body.error.code;

    expect(await code(acme.search({ query: '   ' }), 400)).toBe('invalid_request');
    expect(await code(acme.search({ query: 'x', topK: 0 }), 400)).toBe('invalid_request');
    expect(await code(acme.search({ query: 'x', mode: 'fuzzy' }), 400)).toBe('invalid_request');
    expect(
      await code(
        acme.put('/v1/tenants/acme/index/documents/d', {
          chunks: [
            { index: 0, text: 'a' },
            { index: 0, text: 'b' },
          ],
        }),
        400,
      ),
    ).toBe('invalid_request');
  });
});
