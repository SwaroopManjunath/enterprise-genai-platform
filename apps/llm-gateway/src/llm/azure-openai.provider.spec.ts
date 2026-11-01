import { AzureOpenAiProvider, parseRetryAfter } from './azure-openai.provider';
import { ProviderError } from './provider-error';

const config = {
  name: 'aoai-primary',
  endpoint: 'https://example.openai.azure.com/',
  deployment: 'gpt-4o',
  apiKey: 'secret-key',
  apiVersion: '2024-10-21',
};

const request = { messages: [{ role: 'user' as const, content: 'hi' }] };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('AzureOpenAiProvider', () => {
  it('calls the deployment URL with the api-key header and maps the response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
    const provider = new AzureOpenAiProvider(config, 1000, fetchMock);

    const result = await provider.chat(request);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://example.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
    );
    expect((init.headers as Record<string, string>)['api-key']).toBe('secret-key');
    expect(result).toEqual({
      message: { role: 'assistant', content: 'hello' },
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      provider: 'aoai-primary',
    });
  });

  it.each([
    [429, true, true],
    [503, true, true],
    [401, false, true],
    [400, false, false],
  ])(
    'classifies HTTP %i (retryable=%p, fallbackable=%p)',
    async (status, retryable, fallbackable) => {
      const fetchMock = jest.fn().mockResolvedValue(new Response('nope', { status }));
      const provider = new AzureOpenAiProvider(config, 1000, fetchMock);

      const error = await provider.chat(request).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(retryable);
      expect((error as ProviderError).fallbackable).toBe(fallbackable);
    },
  );

  it('treats network failures as retryable and fallbackable', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const provider = new AzureOpenAiProvider(config, 1000, fetchMock);

    const error = (await provider.chat(request).catch((e: unknown) => e)) as ProviderError;

    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(true);
    expect(error.fallbackable).toBe(true);
  });

  it('never leaks the api key into error messages', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const provider = new AzureOpenAiProvider(config, 1000, fetchMock);

    const error = (await provider.chat(request).catch((e: unknown) => e)) as ProviderError;

    expect(error.message).not.toContain('secret-key');
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => expect(parseRetryAfter('2')).toBe(2000));
  it('returns undefined when absent or garbage', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('AzureOpenAiProvider.chatStream', () => {
  const sse = (...events: string[]): Response =>
    new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const chunk = (content: string, finish?: string) =>
    JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish ?? null }] });
  const usageChunk = JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
  const collect = async (provider: AzureOpenAiProvider) => {
    const events = [];
    for await (const event of provider.chatStream(request)) events.push(event);
    return events;
  };

  it('asks for a stream with usage, and maps pieces, finish reason and usage', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(sse(chunk('Hel'), chunk('lo'), chunk('', 'stop'), usageChunk, '[DONE]'));
    const provider = new AzureOpenAiProvider(config, 1000, fetchMock);

    const events = await collect(provider);

    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        provider: 'aoai-primary',
      },
    ]);
  });

  it('reports zero usage when the deployment sends none, so the gateway can estimate', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sse(chunk('hi', 'stop'), '[DONE]'));

    const events = await collect(new AzureOpenAiProvider(config, 1000, fetchMock));

    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { totalTokens: 0 } });
  });

  it('classifies an error status before the stream starts, like a normal call', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '2' } }));

    const error = await collect(new AzureOpenAiProvider(config, 1000, fetchMock)).catch(
      (e: ProviderError) => e,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 2000, retryable: true });
  });

  it('treats a network failure as retryable and fallbackable', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('socket hang up'));

    const error = await collect(new AzureOpenAiProvider(config, 1000, fetchMock)).catch(
      (e: ProviderError) => e,
    );

    expect(error).toMatchObject({ retryable: true, fallbackable: true });
  });

  it('fails clearly on a malformed stream', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sse(chunk('ok'), '{not json'));

    const error = await collect(new AzureOpenAiProvider(config, 1000, fetchMock)).catch(
      (e: ProviderError) => e,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(502);
  });

  it('cuts a stream that goes quiet, but not one that is merely long', async () => {
    const quiet = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${chunk('start')}\n\n`));
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const error = await collect(new AzureOpenAiProvider(config, 50, quiet)).catch(
      (e: ProviderError) => e,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/quiet|failed/);
  });

  it('closes the connection when the caller stops reading', async () => {
    let aborted = false;
    const fetchMock = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return Promise.resolve(sse(chunk('a'), chunk('b'), '[DONE]'));
    });
    const stream = new AzureOpenAiProvider(config, 1000, fetchMock).chatStream(request);

    await stream.next();
    await stream.return(undefined);

    expect(aborted).toBe(true);
  });
});
