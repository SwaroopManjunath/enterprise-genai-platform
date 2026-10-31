import { seedDocuments, startStack, type Stack } from './stack';

const analyst = { tenant: 'acme-bank', userId: 'bob', roles: ['analyst'] };
const manager = { tenant: 'acme-bank', userId: 'alice', roles: ['manager'] };
const globexUser = { tenant: 'globex', userId: 'gina', roles: ['analyst'] };

const REFUNDS = 'How long do refunds take?';
const SALARY = 'What are the salary bands for managers?';

const promptTemplate = (tag: string) =>
  `${tag}: use ONLY the numbered sources and cite them as [n].\n\nSources:\n{{sources}}\n\nQuestion: {{question}}`;

describe('login -> ask -> cited answer, across the real services', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
    await seedDocuments(stack);
  });
  afterAll(async () => {
    await stack.stop();
  });

  it('returns a cited answer, retrieved as the user and generated through the gateway', async () => {
    const res = await stack.ask(analyst, REFUNDS);

    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/five working days/i);
    expect(res.body.grounded).toBe(true);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0]).toMatchObject({
      marker: 1,
      documentId: 'handbook',
      chunkId: 'handbook:0',
      headingPath: ['Refunds'],
    });
    expect(res.body.citations[0].excerpt).toContain('Refunds take five working days');
    expect(res.body.model.provider).toBe('mock-grounded');
    expect(res.body.usage.totalTokens).toBeGreaterThan(0);
  });

  it('gives two users the same question and different answers, because of their roles', async () => {
    const callsBefore = stack.llm.calls;

    const asAnalyst = await stack.ask(analyst, SALARY);
    // The analyst has no permitted source, so the model is never called and nothing leaks.
    expect(asAnalyst.status).toBe(200);
    expect(asAnalyst.body).toMatchObject({ grounded: false, citations: [], sourcesRetrieved: 0 });
    expect(asAnalyst.body.answer).toMatch(/could not find anything/i);
    expect(JSON.stringify(asAnalyst.body)).not.toMatch(/salary-bands|level M1/i);
    expect(stack.llm.calls).toBe(callsBefore);

    const asManager = await stack.ask(manager, SALARY);
    expect(asManager.status).toBe(200);
    expect(asManager.body.grounded).toBe(true);
    expect(asManager.body.answer).toMatch(/level M1/);
    expect(asManager.body.citations[0]).toMatchObject({
      documentId: 'salary-bands',
      headingPath: ['Salary bands'],
    });
    expect(stack.llm.calls).toBe(callsBefore + 1);
  });

  it('cannot be talked into a wider view with spoofed headers or body fields', async () => {
    const res = await stack.ask(analyst, SALARY, {
      headers: { 'x-roles': 'manager', 'x-tenant-id': 'acme-bank' },
      body: { roles: ['manager'], tenant: 'acme-bank', filter: { documentIds: ['salary-bands'] } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ grounded: false, sourcesRetrieved: 0 });
  });

  it('keeps tenants apart, even when both have a document with the same id', async () => {
    const res = await stack.ask(globexUser, REFUNDS);

    expect(res.body.grounded).toBe(true);
    expect(res.body.answer).toMatch(/ten working days/i);
    expect(JSON.stringify(res.body)).not.toMatch(/five working days/i);
  });

  it('says it cannot find an answer for a question the documents do not cover', async () => {
    const res = await stack.ask(analyst, 'What is the capital of France?');

    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(false);
    expect(res.body.citations).toEqual([]);
  });

  it('uses the prompt registry: built-in first, then a published version, a newer one, and a rollback', async () => {
    const version = async () => (await stack.ask(analyst, REFUNDS)).body.prompt;

    expect(await version()).toMatchObject({ source: 'builtin', version: 'builtin' });

    await stack.publishPrompt('acme-bank', 'rag-answer', promptTemplate('v1'));
    expect(await version()).toMatchObject({ source: 'registry', version: 1 });

    const v2 = await stack.publishPrompt('acme-bank', 'rag-answer', promptTemplate('v2'), 2);
    expect(v2).toBe(2);
    expect(await version()).toMatchObject({ source: 'registry', version: 2 });

    await stack.call('PUT', 'prompts', '/v1/prompts/rag-answer/active', {
      token: stack.token('prompts', { tenant: 'acme-bank', roles: ['prompt-admin'] }),
      body: { version: 1 },
    });
    expect(await version()).toMatchObject({ source: 'registry', version: 1 });
    // The answer still comes back cited whichever prompt version is active.
    expect((await stack.ask(analyst, REFUNDS)).body.grounded).toBe(true);
  });

  describe('authentication', () => {
    it('rejects no token, an expired token, and a token minted for a different service', async () => {
      const noToken = await stack.call('POST', 'assistant', '/v1/ask', {
        body: { question: REFUNDS },
      });
      expect(noToken.status).toBe(401);

      const expired = stack.issuer.mint({
        tenant: 'acme-bank',
        audience: 'api://assistant',
        expiresInSec: -999,
      });
      expect(
        (
          await stack.call('POST', 'assistant', '/v1/ask', {
            token: expired,
            body: { question: REFUNDS },
          })
        ).status,
      ).toBe(401);

      const wrongAudience = stack.token('retrieval', analyst);
      const res = await stack.call('POST', 'assistant', '/v1/ask', {
        token: wrongAudience,
        body: { question: REFUNDS },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('does not let the user token reach the downstream services directly', async () => {
      // The user's token is for the assistant. Retrieval and the gateway only honour tokens issued
      // for them, and those come only from the on-behalf-of exchange.
      const userToken = stack.token('assistant', manager);

      const search = await stack.call('POST', 'retrieval', '/v1/search', {
        token: userToken,
        body: { query: SALARY },
      });
      const chat = await stack.call('POST', 'gateway', '/v1/chat/completions', {
        token: userToken,
        body: { messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(search.status).toBe(401);
      expect(chat.status).toBe(401);
    });

    it('does not let an end user write to the search index, even a manager', async () => {
      const res = await stack.call('PUT', 'retrieval', '/v1/index/documents/planted', {
        token: stack.token('retrieval', manager),
        body: { chunks: [{ index: 0, text: 'planted content about refunds' }] },
      });
      expect(res.status).toBe(403);
    });
  });

  it('echoes the correlation id', async () => {
    const res = await stack.ask(analyst, REFUNDS, { headers: { 'x-request-id': 'trace-e2e-1' } });
    expect(res.headers.get('x-request-id')).toBe('trace-e2e-1');
    expect(res.body.requestId).toBe('trace-e2e-1');
  });
});

describe('when a dependency is down', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await startStack();
    await seedDocuments(stack);
  });
  afterEach(async () => {
    await stack.stop();
  });

  it('reports a temporary 503 if the gateway is gone, and never a stack trace', async () => {
    await stack.stopService('gateway');

    const res = await stack.ask(analyst, REFUNDS);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('assistant_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|at \w+\.|127\.0\.0\.1/);
  });

  it('reports a temporary 503 if retrieval is gone', async () => {
    await stack.stopService('retrieval');
    expect((await stack.ask(analyst, REFUNDS)).status).toBe(503);
  });

  it('keeps answering, with the built-in prompt, if only the prompt registry is gone', async () => {
    await stack.stopService('prompts');

    const res = await stack.ask(analyst, REFUNDS);

    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(true);
    expect(res.body.prompt.source).toBe('builtin');
  });
});
