import { OBO_CLIENT, OboExchangeError, TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import { DownstreamError } from '@genai/shared';
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

function fakes() {
  return {
    retrieval: { search: jest.fn().mockResolvedValue([hit]) },
    prompts: { resolve: jest.fn().mockResolvedValue({ version: 1, rendered: 'PROMPT' }) },
    gateway: {
      chat: jest.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Five working days. [1]' },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        provider: 'mock-grounded',
        fallbackUsed: false,
      }),
    },
    obo: { exchange: jest.fn().mockResolvedValue('downstream-token') },
  };
}

describe('POST /v1/ask', () => {
  let app: INestApplication;
  let f: ReturnType<typeof fakes>;

  beforeEach(async () => {
    f = fakes();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(issuer.verifier(30, AUDIENCE))
      .overrideProvider(ASSISTANT_CONFIG)
      .useValue(
        loadConfig({ OBO_TOKEN_ENDPOINT: 'http://x.test/token', OBO_CLIENT_ID: 'assistant' }),
      )
      .overrideProvider(RetrievalClient)
      .useValue(f.retrieval)
      .overrideProvider(PromptClient)
      .useValue(f.prompts)
      .overrideProvider(GatewayClient)
      .useValue(f.gateway)
      .overrideProvider(OBO_CLIENT)
      .useValue(f.obo)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  const token = (overrides: Parameters<TestIssuer['mint']>[0] = { tenant: 'acme-bank' }) =>
    issuer.mint({ audience: AUDIENCE, userId: 'alice', ...overrides });
  const ask = (body: object, bearer: string | undefined = token()) => {
    const req = request(app.getHttpServer()).post('/v1/ask');
    return (bearer ? req.set('authorization', `Bearer ${bearer}`) : req).send(body);
  };

  it('returns a cited answer and echoes a correlation id', async () => {
    const res = await ask({ question: 'How long do refunds take?' })
      .set('x-request-id', 'trace-7')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('trace-7');
    expect(res.body).toMatchObject({
      requestId: 'trace-7',
      answer: 'Five working days. [1]',
      grounded: true,
      citations: [{ marker: 1, documentId: 'faq', chunkId: 'faq:0' }],
    });
  });

  it('generates a request id when none is sent', async () => {
    const res = await ask({ question: 'refunds?' }).expect(200);
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires a valid token for this API: none, expired, or one issued for another service', async () => {
    await ask({ question: 'q' }, '').expect(401);
    await ask({ question: 'q' }, token({ tenant: 'acme', expiresInSec: -999 })).expect(401);
    // A token minted for the retrieval API must not work here: tokens are bound to one audience.
    const res = await ask(
      { question: 'q' },
      issuer.mint({ tenant: 'acme', audience: 'api://retrieval' }),
    ).expect(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(f.retrieval.search).not.toHaveBeenCalled();
  });

  it('validates the question', async () => {
    for (const body of [
      {},
      { question: '   ' },
      { question: 'x'.repeat(2001) },
      { question: 'q', topK: 99 },
    ]) {
      const res = await ask(body).expect(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
    expect(f.retrieval.search).not.toHaveBeenCalled();
  });

  it('passes the user’s token to the on-behalf-of exchange, and takes identity from nowhere else', async () => {
    const bearer = token({ tenant: 'acme-bank' });
    await ask({ question: 'q' }, bearer)
      .set('x-tenant-id', 'globex')
      .set('x-roles', 'manager')
      .expect(200);

    for (const call of f.obo.exchange.mock.calls as [string, string][])
      expect(call[0]).toBe(bearer);
  });

  describe('failure mapping', () => {
    it('passes on a rate limit or quota with Retry-After', async () => {
      f.gateway.chat.mockRejectedValue(
        new DownstreamError('gateway', 'http', 429, 'quota_exceeded', 9),
      );

      const res = await ask({ question: 'q' }).expect(429);

      expect(res.headers['retry-after']).toBe('9');
      expect(res.body.error).toMatchObject({ code: 'quota_exceeded', retryAfterSeconds: 9 });
    });

    it('reports a dead or slow dependency as a temporary 503', async () => {
      f.retrieval.search.mockRejectedValue(new DownstreamError('retrieval', 'unreachable'));
      expect((await ask({ question: 'q' }).expect(503)).body.error.code).toBe(
        'assistant_unavailable',
      );

      f.retrieval.search.mockRejectedValue(new DownstreamError('retrieval', 'timeout'));
      await ask({ question: 'q' }).expect(503);

      f.retrieval.search.mockRejectedValue(new DownstreamError('retrieval', 'http', 500));
      await ask({ question: 'q' }).expect(503);
    });

    it('reports a dependency rejecting our credentials as our problem (502), without detail', async () => {
      f.retrieval.search.mockRejectedValue(
        new DownstreamError('retrieval', 'http', 401, 'unauthorized'),
      );
      const res = await ask({ question: 'q' }).expect(502);
      expect(res.body.error.code).toBe('dependency_auth_failed');
      expect(JSON.stringify(res.body)).not.toContain('retrieval');
    });

    it('maps on-behalf-of failures: consent needed, provider down, and other refusals', async () => {
      f.obo.exchange.mockRejectedValueOnce(new OboExchangeError('interaction_required', 400));
      expect((await ask({ question: 'q' }).expect(403)).body.error.code).toBe(
        'interaction_required',
      );

      f.obo.exchange.mockRejectedValueOnce(new OboExchangeError('identity_provider_unreachable'));
      await ask({ question: 'q' }).expect(503);

      f.obo.exchange.mockRejectedValueOnce(new OboExchangeError('invalid_grant', 400));
      expect((await ask({ question: 'q' }).expect(502)).body.error.code).toBe(
        'dependency_auth_failed',
      );
    });
  });
});
