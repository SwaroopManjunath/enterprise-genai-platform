import { OBO_CLIENT, TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GatewayClient, PromptClient, RetrievalClient } from '../src/clients/service-clients';
import { ASSISTANT_CONFIG, loadConfig } from '../src/config/config';

const AUDIENCE = 'api://assistant';
const issuer = new TestIssuer();

const hit = {
  chunkId: 'faq:0',
  documentId: 'faq',
  text: '# Refunds\nRefunds take five working days.',
  metadata: { headingPath: ['Refunds'] },
  score: 1.4,
};

describe('answer cache over HTTP', () => {
  let app: INestApplication;
  let chat: jest.Mock;

  beforeEach(async () => {
    chat = jest.fn().mockResolvedValue({
      message: { role: 'assistant', content: 'Five working days. [1]' },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      provider: 'mock-grounded',
      fallbackUsed: false,
      cost: { microUsd: 2_500_000, priced: true },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(issuer.verifier(30, AUDIENCE))
      .overrideProvider(ASSISTANT_CONFIG)
      .useValue(
        loadConfig({
          OBO_TOKEN_ENDPOINT: 'http://x.test/token',
          OBO_CLIENT_ID: 'assistant',
          CACHE_MODE: 'serve',
        }),
      )
      .overrideProvider(RetrievalClient)
      .useValue({ search: jest.fn().mockResolvedValue([hit]) })
      .overrideProvider(PromptClient)
      .useValue({ resolve: jest.fn().mockResolvedValue({ version: 1, rendered: 'PROMPT' }) })
      .overrideProvider(GatewayClient)
      .useValue({ chat })
      .overrideProvider(OBO_CLIENT)
      .useValue({ exchange: jest.fn().mockResolvedValue('downstream-token') })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  const token = (tenant: string, roles: string[] = []) =>
    issuer.mint({ audience: AUDIENCE, userId: 'alice', tenant, roles });
  const ask = (body: object, tenant = 'acme') =>
    request(app.getHttpServer())
      .post('/v1/ask')
      .set('authorization', `Bearer ${token(tenant)}`)
      .send(body);
  const stats = (tenant: string, roles: string[]) =>
    request(app.getHttpServer())
      .get('/v1/cache/stats')
      .set('authorization', `Bearer ${token(tenant, roles)}`);

  it('answers a repeat from the cache and says so', async () => {
    const first = await ask({ question: 'How long do refunds take?' }).expect(200);
    const second = await ask({ question: 'How long do refunds take?' }).expect(200);

    expect(first.body.cache.status).toBe('miss');
    expect(second.body.cache).toMatchObject({
      status: 'hit',
      kind: 'exact',
      savedMicroUsd: 2_500_000,
    });
    expect(second.body.answer).toBe(first.body.answer);
    expect(second.body.timings.modelMs).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('shows cost-viewers their own tenant’s cache numbers, and nobody else', async () => {
    await ask({ question: 'How long do refunds take?' });
    await ask({ question: 'how long does a refund take' });
    await ask({ question: 'How long do refunds take?' }, 'globex');

    const mine = await stats('acme', ['cost-viewer']).expect(200);

    expect(mine.body).toMatchObject({
      tenantId: 'acme',
      hits: 1,
      misses: 1,
      semanticHits: 1,
      hitRate: 0.5,
      savedUsd: 2.5,
    });
    expect((await stats('globex', ['cost-viewer']).expect(200)).body).toMatchObject({
      hits: 0,
      misses: 1,
    });
    await stats('acme', []).expect(403);
    await request(app.getHttpServer()).get('/v1/cache/stats').expect(401);
  });

  it('accepts noCache for a fresh answer, and rejects a non-boolean', async () => {
    await ask({ question: 'How long do refunds take?' });

    const fresh = await ask({ question: 'How long do refunds take?', noCache: true }).expect(200);

    expect(fresh.body.cache).toEqual({ status: 'bypass' });
    expect(chat).toHaveBeenCalledTimes(2);
    await ask({ question: 'q', noCache: 'yes' }).expect(400);
  });
});
