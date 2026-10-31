import { TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from '../src/limits/rate-limiter';
import { InMemoryTokenQuota, TOKEN_QUOTA } from '../src/limits/token-quota';
import { failing, MockProvider } from '../src/llm/mock.provider';
import type { LlmProvider } from '../src/llm/types';
import { LlmRouter } from '../src/resilience/llm-router';

const retry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() };
const body = { messages: [{ role: 'user', content: 'hello gateway' }] };
const issuer = new TestIssuer();

interface Overrides {
  providers?: LlmProvider[];
  requestsPerMinute?: number;
  dailyTokenQuota?: number;
}

async function createApp(overrides: Overrides = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(issuer.verifier())
    .overrideProvider(LlmRouter)
    .useValue(new LlmRouter(overrides.providers ?? [new MockProvider()], retry))
    .overrideProvider(RATE_LIMITER)
    .useValue(new InMemoryTokenBucketRateLimiter(overrides.requestsPerMinute ?? 1000))
    .overrideProvider(TOKEN_QUOTA)
    .useValue(new InMemoryTokenQuota(overrides.dailyTokenQuota ?? 1_000_000));
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

describe('POST /v1/chat/completions', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app.close();
  });

  const post = (tenant: string | undefined, payload: unknown = body) => {
    const req = request(app.getHttpServer()).post('/v1/chat/completions');
    if (tenant !== undefined) req.set('authorization', `Bearer ${issuer.mint({ tenant })}`);
    return req.send(payload as object);
  };

  it('serves a completion and echoes a correlation id', async () => {
    app = await createApp();

    const res = await post('acme').set('x-request-id', 'trace-1').expect(200);

    expect(res.body).toMatchObject({
      requestId: 'trace-1',
      provider: 'mock',
      fallbackUsed: false,
      message: { role: 'assistant', content: 'echo: hello gateway' },
      finishReason: 'stop',
    });
    expect(res.body.usage.totalTokens).toBeGreaterThan(0);
    expect(res.headers['x-request-id']).toBe('trace-1');
  });

  it('requires a valid token: no token, expired, wrong audience and forged all get 401', async () => {
    app = await createApp();
    const send = (authorization?: string) => {
      const req = request(app.getHttpServer()).post('/v1/chat/completions');
      return (authorization ? req.set('authorization', authorization) : req).send(body);
    };

    await send().expect(401);
    await send(`Bearer ${issuer.mint({ tenant: 'acme', expiresInSec: -999 })}`).expect(401);
    await send(`Bearer ${issuer.mint({ tenant: 'acme', audience: 'api://other' })}`).expect(401);
    await send(`Bearer ${issuer.forge.otherKey({ tenant: 'acme' })}`).expect(401);
    const res = await send(`Bearer ${issuer.mint({ tenant: 'Not A Tenant!' })}`).expect(401);

    expect(res.body.error.code).toBe('unauthorized');
  });

  it('takes the tenant from the token and ignores a spoofed x-tenant-id header', async () => {
    app = await createApp({ requestsPerMinute: 1 });
    const token = `Bearer ${issuer.mint({ tenant: 'acme' })}`;
    const call = (spoofedTenant: string) =>
      request(app.getHttpServer())
        .post('/v1/chat/completions')
        .set('authorization', token)
        .set('x-tenant-id', spoofedTenant)
        .send(body);

    await call('globex').expect(200);
    // A different claimed tenant does not buy a fresh rate-limit bucket: still tenant "acme".
    await call('initech').expect(429);
  });

  it('rejects an invalid body with field-level issues', async () => {
    app = await createApp();

    const res = await post('acme', { messages: [] }).expect(400);

    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.issues[0].path).toBe('messages');
  });

  it('falls back to the secondary deployment when the primary is down', async () => {
    app = await createApp({
      providers: [
        new MockProvider(failing(503, 'primary')),
        new MockProvider({ name: 'secondary' }),
      ],
    });

    const res = await post('acme').expect(200);

    expect(res.body.provider).toBe('secondary');
    expect(res.body.fallbackUsed).toBe(true);
  });

  it('returns 503 when every deployment is down', async () => {
    app = await createApp({
      providers: [new MockProvider(failing(503, 'a')), new MockProvider(failing(500, 'b'))],
    });

    const res = await post('acme').expect(503);

    expect(res.body.error.code).toBe('upstream_unavailable');
  });

  it('returns 400 (without trying a fallback) when the model rejects the request itself', async () => {
    const secondary = new MockProvider({ name: 'secondary' });
    app = await createApp({ providers: [new MockProvider(failing(400, 'primary')), secondary] });

    const res = await post('acme').expect(400);

    expect(res.body.error.code).toBe('upstream_rejected_request');
    expect(secondary.calls).toBe(0);
  });

  it('rate limits per tenant with a Retry-After header, without affecting other tenants', async () => {
    app = await createApp({ requestsPerMinute: 1 });

    await post('noisy').expect(200);
    const limited = await post('noisy').expect(429);
    await post('quiet').expect(200);

    expect(limited.body.error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('blocks a tenant that exhausted its daily token quota', async () => {
    app = await createApp({ dailyTokenQuota: 1 });

    await post('acme').expect(200); // first call is allowed, then consumes more than the quota
    const res = await post('acme').expect(429);

    expect(res.body.error.code).toBe('quota_exceeded');
    await post('globex').expect(200);
  });
});
