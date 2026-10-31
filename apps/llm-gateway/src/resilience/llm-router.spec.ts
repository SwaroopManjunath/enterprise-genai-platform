import { failing, MockProvider } from '../llm/mock.provider';
import type { ProviderError } from '../llm/provider-error';
import { AllProvidersFailedError, LlmRouter } from './llm-router';

const request = { messages: [{ role: 'user' as const, content: 'ping' }] };
const retry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() };

describe('LlmRouter', () => {
  it('uses the primary when healthy and does not touch the fallback', async () => {
    const primary = new MockProvider({ name: 'primary' });
    const secondary = new MockProvider({ name: 'secondary' });
    const router = new LlmRouter([primary, secondary], retry);

    const result = await router.chat(request);

    expect(result.provider).toBe('primary');
    expect(result.fallbackUsed).toBe(false);
    expect(secondary.calls).toBe(0);
  });

  it('retries the primary before falling back, then serves from the secondary', async () => {
    const primary = new MockProvider(failing(503, 'primary'));
    const secondary = new MockProvider({ name: 'secondary' });
    const router = new LlmRouter([primary, secondary], retry);

    const result = await router.chat(request);

    expect(primary.calls).toBe(2); // maxAttempts
    expect(result.provider).toBe('secondary');
    expect(result.fallbackUsed).toBe(true);
  });

  it('falls back immediately (no retries) when the primary is misconfigured', async () => {
    const primary = new MockProvider(failing(401, 'primary'));
    const secondary = new MockProvider({ name: 'secondary' });
    const router = new LlmRouter([primary, secondary], retry);

    const result = await router.chat(request);

    expect(primary.calls).toBe(1);
    expect(result.provider).toBe('secondary');
  });

  it('does not fall back on a request every deployment would reject', async () => {
    const primary = new MockProvider(failing(400, 'primary'));
    const secondary = new MockProvider({ name: 'secondary' });
    const router = new LlmRouter([primary, secondary], retry);

    await expect(router.chat(request)).rejects.toMatchObject({ status: 400 });
    expect(secondary.calls).toBe(0);
  });

  it('throws AllProvidersFailedError carrying every failure when all are down', async () => {
    const router = new LlmRouter(
      [new MockProvider(failing(503, 'a')), new MockProvider(failing(500, 'b'))],
      retry,
    );

    const error = await router.chat(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect((error as AllProvidersFailedError).failures.map((f) => f.provider)).toEqual(['a', 'b']);
  });

  it('reports each failed deployment through the onFailure hook (for metrics)', async () => {
    const seen: ProviderError[] = [];
    const router = new LlmRouter(
      [new MockProvider(failing(503, 'a')), new MockProvider({ name: 'b' })],
      retry,
      (e) => seen.push(e),
    );

    await router.chat(request);

    expect(seen.map((e) => e.provider)).toEqual(['a']);
  });

  it('rejects an empty provider list at construction', () => {
    expect(() => new LlmRouter([], retry)).toThrow(/at least one/);
  });
});
