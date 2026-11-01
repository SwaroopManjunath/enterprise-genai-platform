import { failing, MockProvider } from '../llm/mock.provider';
import { ProviderError } from '../llm/provider-error';
import type { LlmProvider } from '../llm/types';
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

describe('LlmRouter.chatStream', () => {
  const drain = async (router: LlmRouter) => {
    const events = [];
    for await (const event of router.chatStream(request)) events.push(event);
    return events;
  };
  const text = (events: { type: string; text?: string }[]) =>
    events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');

  it('streams from the primary and tags each event with who served it', async () => {
    const router = new LlmRouter(
      [new MockProvider({ name: 'primary' }), new MockProvider({ name: 'secondary' })],
      retry,
    );

    const events = await drain(router);

    expect(text(events)).toBe('echo: ping');
    expect(events.every((e) => e.provider === 'primary' && !e.fallbackUsed)).toBe(true);
  });

  it('falls back to the secondary when the primary fails before sending anything', async () => {
    const primary = new MockProvider(failing(503, 'primary'));
    const router = new LlmRouter([primary, new MockProvider({ name: 'secondary' })], retry);

    const events = await drain(router);

    expect(primary.calls).toBe(2); // retried first
    expect(text(events)).toBe('echo: ping');
    expect(events.every((e) => e.provider === 'secondary' && e.fallbackUsed)).toBe(true);
  });

  it('does not start a second answer when the primary breaks after sending text', async () => {
    const secondary = new MockProvider({ name: 'secondary' });
    const broken: LlmProvider = {
      name: 'primary',
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream() {
        yield { type: 'delta', text: 'partial ' };
        throw new ProviderError('primary', 'connection reset', { status: 503 });
      },
    };
    const router = new LlmRouter([broken, secondary], retry);

    const received: string[] = [];
    const error = await (async () => {
      try {
        for await (const e of router.chatStream(request))
          if (e.type === 'delta') received.push(e.text);
      } catch (e) {
        return e;
      }
    })();

    expect(received).toEqual(['partial ']);
    expect(error).toBeInstanceOf(ProviderError);
    expect(secondary.calls).toBe(0);
  });

  it('throws straight away for a request every deployment would reject', async () => {
    const secondary = new MockProvider({ name: 'secondary' });
    const router = new LlmRouter([new MockProvider(failing(400, 'primary')), secondary], retry);

    await expect(drain(router)).rejects.toMatchObject({ status: 400 });
    expect(secondary.calls).toBe(0);
  });

  it('fails when every deployment is down', async () => {
    const router = new LlmRouter(
      [new MockProvider(failing(503, 'a')), new MockProvider(failing(503, 'b'))],
      retry,
    );

    await expect(drain(router)).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('closes the underlying stream when the caller stops early', async () => {
    let closed = false;
    const provider: LlmProvider = {
      name: 'p',
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream() {
        try {
          for (;;) yield { type: 'delta', text: 'x' };
        } finally {
          closed = true;
        }
      },
    };
    const stream = new LlmRouter([provider], retry).chatStream(request);

    await stream.next();
    await stream.return(undefined);

    expect(closed).toBe(true);
  });
});
