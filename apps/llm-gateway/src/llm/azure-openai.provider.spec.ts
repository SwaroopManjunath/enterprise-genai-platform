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
