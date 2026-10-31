import { HttpJsonClient } from '@genai/shared';
import { GatewayClient, PromptClient, RetrievalClient } from './service-clients';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const clientWith = (fetchImpl: jest.Mock, timeoutMs = 1000) =>
  new HttpJsonClient({ service: 'retrieval', baseUrl: 'http://svc.test/', timeoutMs, fetchImpl });

describe('service clients', () => {
  it('retrieval: asks for hybrid, reranked search and returns the hits', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ results: [{ chunkId: 'a:0' }] }));
    const client = new RetrievalClient(clientWith(fetchImpl));

    const hits = await client.search('tok', { query: 'refunds', topK: 3 }, 'req-1');

    expect(hits).toEqual([{ chunkId: 'a:0' }]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://svc.test/v1/search');
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'refunds',
      topK: 3,
      mode: 'hybrid',
      rerank: true,
    });
    expect((init.headers as Record<string, string>)['x-request-id']).toBe('req-1');
  });

  it('prompts: resolves by name, URL-encoded', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ version: 2, rendered: 'hi' }));
    const client = new PromptClient(clientWith(fetchImpl));

    await client.resolve('tok', 'rag answer/../x', { variables: {}, subjectKey: 'u1' }, 'r');

    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
      'http://svc.test/v1/prompts/rag%20answer%2F..%2Fx/resolve',
    );
  });

  it('gateway: sends chat messages', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(json({ message: { role: 'assistant', content: 'x' } }));
    await new GatewayClient(clientWith(fetchImpl)).chat(
      'tok',
      [{ role: 'user', content: 'q' }],
      'r',
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://svc.test/v1/chat/completions');
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: 'user', content: 'q' }] });
  });
});
