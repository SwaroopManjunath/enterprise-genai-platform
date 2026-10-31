import type { AuthenticatedPrincipal, OboTokenClient } from '@genai/auth';
import { DownstreamError } from '../clients/http-json-client';
import type { GatewayClient, PromptClient, RetrievalClient } from '../clients/service-clients';
import { AskService, NO_SOURCES_ANSWER } from './ask.service';

const caller: AuthenticatedPrincipal = {
  tenantId: 'acme-bank',
  userId: 'alice',
  roles: ['analyst'],
  scopes: [],
  tokenId: 'jti-1',
  expiresAt: new Date(Date.now() + 3600_000),
  accessToken: 'user-token',
};

const config = {
  gateway: { url: 'http://gw', scope: 'api://gateway/.default' },
  prompts: { url: 'http://pr', scope: 'api://prompt-registry/.default' },
  retrieval: { url: 'http://rt', scope: 'api://retrieval/.default' },
  promptName: 'rag-answer',
  defaultTopK: 4,
};

const refundHit = {
  chunkId: 'faq:0',
  documentId: 'faq',
  text: '# Refunds\nRefunds take five working days.',
  metadata: { headingPath: ['Refunds'] },
  score: 1.4,
};

function setup(overrides: { hits?: unknown[]; answer?: string } = {}) {
  const obo = {
    exchange: jest.fn((_token: string, scope: string) => Promise.resolve(`tok:${scope}`)),
  };
  const retrieval = { search: jest.fn().mockResolvedValue(overrides.hits ?? [refundHit]) };
  const prompts = {
    resolve: jest.fn().mockResolvedValue({ version: 3, rendered: 'REGISTRY PROMPT' }),
  };
  const gateway = {
    chat: jest.fn().mockResolvedValue({
      message: { role: 'assistant', content: overrides.answer ?? 'Five working days. [1]' },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      provider: 'mock-grounded',
      fallbackUsed: false,
    }),
  };
  const service = new AskService(
    {
      retrieval: retrieval as unknown as RetrievalClient,
      prompts: prompts as unknown as PromptClient,
      gateway: gateway as unknown as GatewayClient,
      obo: obo as unknown as OboTokenClient,
    },
    config,
  );
  return { service, obo, retrieval, prompts, gateway };
}

const ask = (service: AskService, question = 'How long do refunds take?', extra = {}) =>
  service.ask(caller, { question, ...extra }, 'req-1');

describe('AskService', () => {
  it('answers with a verified citation, using the registry prompt', async () => {
    const { service } = setup();

    const result = await ask(service);

    expect(result).toMatchObject({
      requestId: 'req-1',
      answer: 'Five working days. [1]',
      grounded: true,
      sourcesRetrieved: 1,
      droppedCitations: [],
      prompt: { name: 'rag-answer', version: 3, source: 'registry' },
      model: { provider: 'mock-grounded', fallbackUsed: false },
      usage: { totalTokens: 15 },
    });
    expect(result.citations).toEqual([
      expect.objectContaining({
        marker: 1,
        documentId: 'faq',
        chunkId: 'faq:0',
        headingPath: ['Refunds'],
      }),
    ]);
  });

  it('acts as the user: exchanges the user token once per downstream API, never forwards it', async () => {
    const { service, obo, retrieval, prompts, gateway } = setup();

    await ask(service);

    expect(obo.exchange.mock.calls).toEqual([
      ['user-token', 'api://retrieval/.default'],
      ['user-token', 'api://prompt-registry/.default'],
      ['user-token', 'api://gateway/.default'],
    ]);
    expect((retrieval.search.mock.calls[0] as unknown[])[0]).toBe('tok:api://retrieval/.default');
    expect((prompts.resolve.mock.calls[0] as unknown[])[0]).toBe(
      'tok:api://prompt-registry/.default',
    );
    expect((gateway.chat.mock.calls[0] as unknown[])[0]).toBe('tok:api://gateway/.default');
    for (const call of [retrieval.search, prompts.resolve, gateway.chat]) {
      expect((call.mock.calls[0] as unknown[])[0]).not.toBe('user-token');
    }
  });

  it('passes the request id and the user as the A/B subject key', async () => {
    const { service, retrieval, prompts, gateway } = setup();

    await ask(service);

    expect((retrieval.search.mock.calls[0] as unknown[])[2]).toBe('req-1');
    expect(prompts.resolve.mock.calls[0]).toEqual([
      'tok:api://prompt-registry/.default',
      'rag-answer',
      expect.objectContaining({ subjectKey: 'alice' }),
      'req-1',
    ]);
    expect((gateway.chat.mock.calls[0] as unknown[])[2]).toBe('req-1');
  });

  it('sends the rendered prompt as the system message and the question as the user message', async () => {
    const { service, gateway } = setup();

    await ask(service, 'How long do refunds take?');

    expect((gateway.chat.mock.calls[0] as unknown[])[1]).toEqual([
      { role: 'system', content: 'REGISTRY PROMPT' },
      { role: 'user', content: 'How long do refunds take?' },
    ]);
  });

  it('never calls the model when nothing was retrieved', async () => {
    const { service, gateway, prompts } = setup({ hits: [] });

    const result = await ask(service, 'What are the salary bands?');

    expect(result).toMatchObject({
      answer: NO_SOURCES_ANSWER,
      citations: [],
      grounded: false,
      sourcesRetrieved: 0,
    });
    expect(result.usage).toBeUndefined();
    expect(gateway.chat).not.toHaveBeenCalled();
    expect(prompts.resolve).not.toHaveBeenCalled();
  });

  it('uses the built-in prompt, with sources and question filled in, when none is published', async () => {
    const { service, prompts, gateway } = setup();
    prompts.resolve.mockRejectedValue(
      new DownstreamError('prompt-registry', 'http', 404, 'prompt_not_found'),
    );

    const result = await ask(service, 'How long do refunds take?');

    expect(result.prompt).toEqual({ name: 'rag-answer', version: 'builtin', source: 'builtin' });
    const system = ((gateway.chat.mock.calls[0] as unknown[])[1] as { content: string }[])[0]
      ?.content;
    expect(system).toContain('[1] Refunds');
    expect(system).toContain('Refunds take five working days.');
    expect(system).toContain('Question: How long do refunds take?');
  });

  it('keeps answering with the built-in prompt when the registry is down', async () => {
    const { service, prompts } = setup();
    prompts.resolve.mockRejectedValue(new DownstreamError('prompt-registry', 'unreachable'));

    const result = await ask(service);

    expect(result.prompt?.source).toBe('builtin');
    expect(result.grounded).toBe(true);
  });

  it('removes hallucinated citations, reports them, and is not grounded if none are real', async () => {
    const { service } = setup({ answer: 'Instant refunds [9].' });

    const result = await ask(service);

    expect(result).toMatchObject({
      answer: 'Instant refunds.',
      citations: [],
      grounded: false,
      droppedCitations: [9],
    });
  });

  it('is not grounded when the model admits it does not know', async () => {
    const { service } = setup({ answer: 'I do not know based on the provided sources.' });
    expect(await ask(service)).toMatchObject({ grounded: false, citations: [] });
  });

  it('uses the default and a custom topK, and passes filters to retrieval', async () => {
    const { service, retrieval } = setup();

    await ask(service);
    await ask(service, 'q', { topK: 2, filter: { tags: ['hr'] } });

    expect((retrieval.search.mock.calls[0] as unknown[])[1]).toEqual({
      query: 'How long do refunds take?',
      topK: 4,
    });
    expect((retrieval.search.mock.calls[1] as unknown[])[1]).toEqual({
      query: 'q',
      topK: 2,
      filter: { tags: ['hr'] },
    });
  });

  it('lets retrieval and gateway failures propagate to be mapped to HTTP responses', async () => {
    const down = setup();
    down.retrieval.search.mockRejectedValue(new DownstreamError('retrieval', 'unreachable'));
    await expect(ask(down.service)).rejects.toBeInstanceOf(DownstreamError);

    const limited = setup();
    limited.gateway.chat.mockRejectedValue(
      new DownstreamError('gateway', 'http', 429, 'rate_limited', 5),
    );
    await expect(ask(limited.service)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 5 });
  });
});
