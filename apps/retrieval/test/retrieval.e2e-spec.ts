import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('retrieval API', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  const as = (tenant: string, roles?: string) => {
    const withHeaders = (r: request.Test) => {
      r.set('x-tenant-id', tenant);
      return roles === undefined ? r : r.set('x-roles', roles);
    };
    const http = () => request(app.getHttpServer());
    return {
      put: (path: string, body: object) => withHeaders(http().put(path)).send(body),
      del: (path: string) => withHeaders(http().delete(path)),
      search: (body: object) => withHeaders(http().post('/v1/search')).send(body),
    };
  };

  const seed = async () => {
    const admin = as('acme');
    await admin.put('/v1/index/documents/faq', {
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
    await admin.put('/v1/index/documents/salary', {
      chunks: [{ index: 0, text: 'Confidential salary bands for managers' }],
      allowedRoles: ['Manager'],
    });
  };

  it('indexes documents and answers a hybrid search with explainable signals', async () => {
    await seed();

    const res = await as('acme', 'analyst')
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

    const analyst = await as('acme', 'analyst')
      .search({ query: 'salary bands managers' })
      .expect(200);
    const manager = await as('acme', 'Manager')
      .search({ query: 'salary bands managers' })
      .expect(200);
    const nobody = await as('acme').search({ query: 'salary bands managers' }).expect(200);

    expect(analyst.body.results.map((r: { documentId: string }) => r.documentId)).not.toContain(
      'salary',
    );
    expect(nobody.body.results.map((r: { documentId: string }) => r.documentId)).not.toContain(
      'salary',
    );
    expect(manager.body.results[0].documentId).toBe('salary');
  });

  it('isolates tenants', async () => {
    await seed();
    const res = await as('globex', 'manager').search({ query: 'refunds salary' }).expect(200);
    expect(res.body.results).toEqual([]);
  });

  it('supports keyword and vector modes, filters and topK', async () => {
    await seed();
    const acme = as('acme', 'manager');

    expect((await acme.search({ query: 'refunding', mode: 'keyword' })).body.count).toBe(0);
    expect(
      (await acme.search({ query: 'refunding', mode: 'vector' })).body.results[0].chunkId,
    ).toBe('faq:0');

    const tagged = await acme.search({
      query: 'salary refunds cards',
      filter: { tags: ['support'] },
    });
    expect(tagged.body.results.every((r: { documentId: string }) => r.documentId === 'faq')).toBe(
      true,
    );

    expect((await acme.search({ query: 'cards refunds', topK: 1 })).body.results).toHaveLength(1);
  });

  it('re-indexing replaces a document and removes stale chunks; delete removes it', async () => {
    await seed();
    const acme = as('acme', 'analyst');

    await acme.put('/v1/index/documents/faq', {
      chunks: [{ index: 0, text: 'Refunds are now instant' }],
    });
    const after = await acme.search({ query: 'cards blocked' });
    expect(after.body.results.map((r: { chunkId: string }) => r.chunkId)).not.toContain('faq:1');

    await acme.del('/v1/index/documents/faq').expect(200);
    await acme.del('/v1/index/documents/faq').expect(404);
    expect((await acme.search({ query: 'refunds instant' })).body.results).toEqual([]);
  });

  it('validates input', async () => {
    const acme = as('acme');
    const code = async (r: request.Test, status: number) =>
      (await r.expect(status)).body.error.code;

    expect(await code(acme.search({ query: '   ' }), 400)).toBe('invalid_request');
    expect(await code(acme.search({ query: 'x', topK: 0 }), 400)).toBe('invalid_request');
    expect(await code(acme.search({ query: 'x', mode: 'fuzzy' }), 400)).toBe('invalid_request');
    expect(
      await code(
        acme.put('/v1/index/documents/d', {
          chunks: [
            { index: 0, text: 'a' },
            { index: 0, text: 'b' },
          ],
        }),
        400,
      ),
    ).toBe('invalid_request');
    expect(await code(as('acme', 'bad role!').search({ query: 'x' }), 400)).toBe('invalid_roles');
    expect(await code(as('Not A Tenant').search({ query: 'x' }), 400)).toBe('invalid_tenant');
  });
});
