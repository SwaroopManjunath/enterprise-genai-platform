import { TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import { parseSse } from '@genai/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { COST_TRACKER, InMemoryCostTracker } from '../src/cost/cost-tracker';
import { PRICE_BOOK, PriceBook } from '../src/cost/pricing';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from '../src/limits/rate-limiter';
import { InMemoryTokenQuota, TOKEN_QUOTA } from '../src/limits/token-quota';
import { failing, MockProvider } from '../src/llm/mock.provider';
import type { LlmProvider } from '../src/llm/types';
import { LlmRouter } from '../src/resilience/llm-router';

const retry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() };
const issuer = new TestIssuer();
const body = { stream: true, messages: [{ role: 'user', content: 'hello gateway' }] };

describe('POST /v1/chat/completions with stream: true', () => {
  let app: INestApplication;
  let url: string;
  let costs: InMemoryCostTracker;

  async function start(providers: LlmProvider[], options: { quota?: number } = {}) {
    costs = new InMemoryCostTracker();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(issuer.verifier())
      .overrideProvider(LlmRouter)
      .useValue(new LlmRouter(providers, retry))
      .overrideProvider(RATE_LIMITER)
      .useValue(new InMemoryTokenBucketRateLimiter(1000))
      .overrideProvider(TOKEN_QUOTA)
      .useValue(new InMemoryTokenQuota(options.quota ?? 1_000_000))
      .overrideProvider(PRICE_BOOK)
      .useValue(new PriceBook({ mock: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 } }))
      .overrideProvider(COST_TRACKER)
      .useValue(costs)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  }
  afterEach(async () => {
    await app.close();
  });

  const post = (tenant: string, payload: object = body, signal?: AbortSignal) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${issuer.mint({ tenant })}`,
        'x-request-id': 'trace-s1',
      },
      body: JSON.stringify(payload),
      ...(signal && { signal }),
    });
  const readAll = async (res: Response) => {
    const events: { event?: string; data: Record<string, unknown> }[] = [];
    for await (const m of parseSse(res.body as ReadableStream<Uint8Array>)) {
      events.push({ ...(m.event && { event: m.event }), data: JSON.parse(m.data) });
    }
    return events;
  };

  it('delivers text as it is generated, then the usage and cost, as server-sent events', async () => {
    await start([new MockProvider()]);

    const res = await post('acme');
    const events = await readAll(res);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-request-id')).toBe('trace-s1');
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data['text']);
    expect(text.join('')).toBe('echo: hello gateway');
    expect(text.length).toBeGreaterThan(1);
    const done = events.at(-1);
    expect(done?.event).toBe('done');
    expect(done?.data).toMatchObject({
      provider: 'mock',
      fallbackUsed: false,
      finishReason: 'stop',
      estimated: false,
    });
    expect((done?.data['cost'] as { priced: boolean }).priced).toBe(true);
  });

  it('bills a streamed call like any other: quota and spend are recorded when it finishes', async () => {
    await start([new MockProvider()]);

    const events = await readAll(await post('acme'));

    const usage = events.at(-1)?.data['usage'] as { totalTokens: number };
    const day = costs.summary('acme', 1)[0];
    expect(day).toMatchObject({ requests: 1, streamedRequests: 1, estimatedRequests: 0 });
    expect((day?.promptTokens ?? 0) + (day?.completionTokens ?? 0)).toBe(usage.totalTokens);
    expect(day?.costMicroUsd).toBeGreaterThan(0);
  });

  it('refuses before the stream starts, with the usual JSON errors and status codes', async () => {
    await start([new MockProvider(failing(503))]);
    const unavailable = await post('acme');
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as { error: { code: string } }).error.code).toBe(
      'upstream_unavailable',
    );
    await app.close();

    await start([new MockProvider()], { quota: 1 });
    await post('acme').then(readAll); // spends the quota
    const exhausted = await post('acme');
    expect(exhausted.status).toBe(429);
    expect(((await exhausted.json()) as { error: { code: string } }).error.code).toBe(
      'quota_exceeded',
    );

    const invalid = await post('acme', { stream: true, messages: [] });
    expect(invalid.status).toBe(400);
    const unauthenticated = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);
  });

  it('serves the same request without streaming as ordinary JSON', async () => {
    await start([new MockProvider()]);

    const res = await post('acme', { messages: body.messages });

    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { message: { content: string } }).message.content).toBe(
      'echo: hello gateway',
    );
  });

  it('reports a failure after the stream began as an in-band error event', async () => {
    const breaking: LlmProvider = {
      name: 'mock',
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream() {
        yield { type: 'delta', text: 'partial ' };
        throw new Error('boom');
      },
    };
    await start([breaking]);

    const res = await post('acme');
    const events = await readAll(res);

    expect(res.status).toBe(200);
    expect(events.map((e) => e.event)).toEqual(['delta', 'error']);
    // an interrupted answer still cost something: it is billed as an estimate, and says so
    expect(costs.summary('acme', 1)[0]).toMatchObject({ requests: 1, estimatedRequests: 1 });
  });

  it('stops the upstream call when the client hangs up, and still bills what was generated', async () => {
    let upstreamAborted = false;
    const slow: LlmProvider = {
      name: 'mock',
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(_request, signal) {
        signal?.addEventListener('abort', () => {
          upstreamAborted = true;
        });
        for (let i = 0; i < 1000 && !signal?.aborted; i++) {
          yield { type: 'delta', text: 'word ' };
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    };
    await start([slow]);
    const abort = new AbortController();

    const res = await post('acme', body, abort.signal);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));

    expect(upstreamAborted).toBe(true);
    expect(costs.summary('acme', 1)[0]).toMatchObject({
      requests: 1,
      estimatedRequests: 1,
      streamedRequests: 1,
    });
  });
});
