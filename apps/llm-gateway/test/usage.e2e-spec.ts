import { TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { COST_TRACKER, InMemoryCostTracker } from '../src/cost/cost-tracker';
import { PRICE_BOOK, PriceBook, type ModelPrice } from '../src/cost/pricing';
import { DAILY_BUDGET } from '../src/gateway/gateway.service';
import { MockProvider } from '../src/llm/mock.provider';
import { LlmRouter } from '../src/resilience/llm-router';

const retry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() };
const issuer = new TestIssuer();
const body = { messages: [{ role: 'user', content: 'hello gateway' }] };

async function createApp(options: { budgetMicroUsd?: number; priced?: boolean } = {}) {
  const prices: Record<string, ModelPrice> =
    options.priced === false ? {} : { mock: { inputPerMTok: 1_000_000, outputPerMTok: 2_000_000 } };
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(issuer.verifier())
    .overrideProvider(LlmRouter)
    .useValue(new LlmRouter([new MockProvider()], retry))
    .overrideProvider(PRICE_BOOK)
    .useValue(new PriceBook(prices))
    .overrideProvider(COST_TRACKER)
    .useValue(new InMemoryCostTracker())
    .overrideProvider(DAILY_BUDGET)
    .useValue(options.budgetMicroUsd);
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

describe('cost tracking and budgets', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app.close();
  });

  const token = (tenant: string, roles: string[] = []) => issuer.mint({ tenant, roles });
  const chat = (tenant: string) =>
    request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${token(tenant)}`)
      .send(body);
  const usage = (tenant: string, roles: string[], query = '') =>
    request(app.getHttpServer())
      .get(`/v1/usage${query}`)
      .set('authorization', `Bearer ${token(tenant, roles)}`);

  it('returns what each call cost, from the upstream token counts', async () => {
    app = await createApp();

    const res = await chat('acme').expect(200);

    const { promptTokens, completionTokens } = res.body.usage;
    expect(res.body.cost).toEqual({
      microUsd: promptTokens * 1_000_000 + completionTokens * 2_000_000,
      priced: true,
    });
  });

  it('reports an unpriced deployment as unpriced rather than free', async () => {
    app = await createApp({ priced: false });

    const res = await chat('acme').expect(200);

    expect(res.body.cost).toEqual({ microUsd: 0, priced: false });
  });

  it('shows a tenant its own spend by day and provider, to cost-viewers only', async () => {
    app = await createApp();
    await chat('acme').expect(200);
    await chat('acme').expect(200);
    await chat('globex').expect(200);

    const mine = await usage('acme', ['cost-viewer']).expect(200);

    expect(mine.body.tenantId).toBe('acme');
    expect(mine.body.days).toHaveLength(1);
    expect(mine.body.days[0]).toMatchObject({ requests: 2, unpricedRequests: 0 });
    expect(mine.body.days[0].byProvider.mock.requests).toBe(2);
    expect(mine.body.days[0].costUsd).toBeGreaterThan(0);
    expect(mine.body.today.spentUsd).toBe(mine.body.days[0].costUsd);

    await usage('acme', []).expect(403);
    await request(app.getHttpServer()).get('/v1/usage').expect(401);
    const theirs = await usage('globex', ['cost-viewer']).expect(200);
    expect(theirs.body.days[0].requests).toBe(1);
  });

  it('validates the day count', async () => {
    app = await createApp();

    await usage('acme', ['cost-viewer'], '?days=0').expect(400);
    await usage('acme', ['cost-viewer'], '?days=1000').expect(400);
    await usage('acme', ['cost-viewer'], '?days=3').expect(200);
  });

  it('stops a tenant that has spent its daily budget, without affecting others', async () => {
    // one call costs well over 1 dollar at these prices, so the second is refused
    app = await createApp({ budgetMicroUsd: 1_000_000 });

    await chat('acme').expect(200);
    const refused = await chat('acme').expect(429);

    expect(refused.body.error.code).toBe('budget_exceeded');
    await chat('globex').expect(200);
    const view = await usage('acme', ['cost-viewer']).expect(200);
    expect(view.body.today.budgetUsd).toBe(1);
    expect(view.body.today.remainingUsd).toBe(0);
  });
});
