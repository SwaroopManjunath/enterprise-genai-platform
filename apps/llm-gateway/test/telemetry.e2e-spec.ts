import { TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import { initTelemetry, pseudonym, type Telemetry } from '@genai/observability';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from '../src/limits/rate-limiter';
import { failing, MockProvider } from '../src/llm/mock.provider';
import type { LlmProvider } from '../src/llm/types';
import { LlmRouter } from '../src/resilience/llm-router';

const retry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() };
const issuer = new TestIssuer();
const body = { messages: [{ role: 'user', content: 'hello gateway' }] };

describe('what the gateway reports about model calls', () => {
  let app: INestApplication;
  let telemetry: Telemetry;

  const start = async (providers: LlmProvider[], requestsPerMinute = 1000) => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(TOKEN_VERIFIER)
        .useValue(issuer.verifier())
        .overrideProvider(LlmRouter)
        .useValue(new LlmRouter(providers, retry))
        .overrideProvider(RATE_LIMITER)
        .useValue(new InMemoryTokenBucketRateLimiter(requestsPerMinute))
        .compile()
    ).createNestApplication();
    await app.init();
  };
  const post = (tenant: string) =>
    request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${issuer.mint({ tenant })}`)
      .send(body);
  const calls = async () =>
    (await telemetry.memory!.metrics())
      .filter((p) => p.name === 'genai.llm.calls')
      .map((p) => ({
        provider: p.attributes['provider'],
        outcome: p.attributes['outcome'],
        n: p.value,
      }));

  beforeEach(() => {
    telemetry = initTelemetry({
      serviceName: 'gateway',
      traces: 'off',
      metrics: 'memory',
      pseudonymSalt: 's',
    });
  });
  afterEach(async () => {
    await app.close();
    await telemetry.shutdown();
  });

  it('counts a served call with its tokens, its duration and its spend against a pseudonym', async () => {
    await start([new MockProvider()]);

    await post('acme').expect(200);

    expect(await calls()).toEqual([{ provider: 'mock', outcome: 'ok', n: 1 }]);
    const metrics = await telemetry.memory!.metrics();
    const tokens = metrics.filter((p) => p.name === 'genai.llm.tokens');
    expect(tokens.map((p) => p.attributes['direction']).sort()).toEqual(['completion', 'prompt']);
    expect(metrics.find((p) => p.name === 'genai.llm.duration')?.histogram?.count).toBe(1);
    const cost = metrics.find((p) => p.name === 'genai.llm.cost');
    expect(cost?.attributes['tenant']).toBe(pseudonym('acme'));
  });

  it('counts a call the fallback served, so a failing primary is visible while users are fine', async () => {
    await start([
      new MockProvider(failing(503, 'primary')),
      new MockProvider({ name: 'secondary' }),
    ]);

    await post('acme').expect(200);

    expect(await calls()).toEqual([{ provider: 'secondary', outcome: 'fallback_served', n: 1 }]);
  });

  it('counts a call that failed everywhere as an error', async () => {
    await start([new MockProvider(failing(503, 'primary'))]);

    await post('acme').expect(503);

    expect(await calls()).toEqual([{ provider: 'none', outcome: 'error', n: 1 }]);
  });

  it('counts a call refused by a limit as rejected, which is not a fault of the model', async () => {
    await start([new MockProvider()], 1);

    await post('noisy').expect(200);
    await post('noisy').expect(429);

    expect(await calls()).toEqual(
      expect.arrayContaining([
        { provider: 'mock', outcome: 'ok', n: 1 },
        { provider: 'none', outcome: 'rejected', n: 1 },
      ]),
    );
    expect((await calls()).some((c) => c.outcome === 'error')).toBe(false);
  });
});
