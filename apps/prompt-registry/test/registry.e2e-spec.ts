import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('prompt registry API', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const api = (tenant: string | undefined = 'acme') => {
    const h = (r: request.Test) => (tenant ? r.set('x-tenant-id', tenant) : r);
    const http = () => request(app.getHttpServer());
    return {
      get: (path: string) => h(http().get(path)),
      post: (path: string, body: object = {}) => h(http().post(path)).send(body),
      put: (path: string, body: object = {}) => h(http().put(path)).send(body),
      del: (path: string) => h(http().delete(path)),
    };
  };

  it('publishes versions, rolls back, and keeps history', async () => {
    const acme = api();
    await acme.post('/v1/prompts/summary/versions', { template: 'v1 {{doc}}' }).expect(201);
    await acme.post('/v1/prompts/summary/versions', { template: 'v2 {{doc}}' }).expect(201);
    await acme.put('/v1/prompts/summary/active', { version: 2 }).expect(200);
    await acme.put('/v1/prompts/summary/active', { version: 1 }).expect(200); // rollback

    const res = await acme.get('/v1/prompts/summary').expect(200);

    expect(res.body.activeVersion).toBe(1);
    expect(res.body.versions).toHaveLength(2);
    expect(res.body.history.map((e: { kind: string }) => e.kind)).toEqual([
      'initial',
      'activate',
      'rollback',
    ]);
  });

  it('resolves and renders the active version', async () => {
    const acme = api();
    await acme.post('/v1/prompts/summary/versions', { template: 'Summarise {{doc}}' });

    const res = await acme
      .post('/v1/prompts/summary/resolve', { variables: { doc: 'Q3' } })
      .expect(200);

    expect(res.body).toEqual({
      name: 'summary',
      version: 1,
      inExperiment: false,
      rendered: 'Summarise Q3',
    });
  });

  it('runs an A/B experiment with a sticky assignment, then clears it', async () => {
    const acme = api();
    await acme.post('/v1/prompts/summary/versions', { template: 'A {{doc}}' });
    await acme.post('/v1/prompts/summary/versions', { template: 'B {{doc}}' });
    await acme
      .put('/v1/prompts/summary/experiment', {
        variants: [
          { version: 1, weight: 1 },
          { version: 2, weight: 1 },
        ],
      })
      .expect(200);

    const body = { variables: { doc: 'x' }, subjectKey: 'user-7' };
    const first = await acme.post('/v1/prompts/summary/resolve', body).expect(200);
    const second = await acme.post('/v1/prompts/summary/resolve', body).expect(200);
    expect(first.body.inExperiment).toBe(true);
    expect(second.body.version).toBe(first.body.version);

    await acme.del('/v1/prompts/summary/experiment').expect(200);
    const after = await acme.post('/v1/prompts/summary/resolve', body).expect(200);
    expect(after.body).toMatchObject({ version: 1, inExperiment: false });
  });

  it('lists prompt summaries per tenant', async () => {
    await api('acme').post('/v1/prompts/one/versions', { template: 'x' });
    await api('acme').post('/v1/prompts/two/versions', { template: 'y' });
    await api('globex').post('/v1/prompts/other/versions', { template: 'z' });

    const res = await api('acme').get('/v1/prompts').expect(200);

    expect(res.body.prompts.map((p: { name: string }) => p.name).sort()).toEqual(['one', 'two']);
  });

  it("does not expose one tenant's prompts to another", async () => {
    await api('acme').post('/v1/prompts/secret/versions', { template: 'confidential' });

    const res = await api('globex').get('/v1/prompts/secret').expect(404);

    expect(res.body.error.code).toBe('prompt_not_found');
  });

  it('returns 404 for an unknown version and 400 for bad input', async () => {
    const acme = api();
    await acme.post('/v1/prompts/summary/versions', { template: 'x' });

    expect((await acme.get('/v1/prompts/summary/versions/9').expect(404)).body.error.code).toBe(
      'version_not_found',
    );
    expect(
      (await acme.put('/v1/prompts/summary/active', { version: 9 }).expect(404)).body.error.code,
    ).toBe('version_not_found');
    expect((await acme.get('/v1/prompts/summary/versions/abc').expect(400)).body.error.code).toBe(
      'invalid_request',
    );
    expect(
      (await acme.post('/v1/prompts/Bad Name/versions', { template: 'x' }).expect(400)).body.error
        .code,
    ).toBe('invalid_prompt');
  });

  it('reports missing template variables', async () => {
    const acme = api();
    await acme.post('/v1/prompts/summary/versions', { template: '{{a}} {{b}}' });

    const res = await acme
      .post('/v1/prompts/summary/resolve', { variables: { a: '1' } })
      .expect(400);

    expect(res.body.error).toMatchObject({ code: 'missing_variables', missing: ['b'] });
  });

  it('rejects an invalid experiment', async () => {
    const acme = api();
    await acme.post('/v1/prompts/summary/versions', { template: 'x' });

    const res = await acme
      .put('/v1/prompts/summary/experiment', { variants: [{ version: 1, weight: 1 }] })
      .expect(400);

    expect(res.body.error.code).toBe('invalid_experiment');
  });

  it('requires a valid tenant header', async () => {
    const res = await api('').get('/v1/prompts').expect(400);
    expect(res.body.error.code).toBe('invalid_tenant');
  });
});
