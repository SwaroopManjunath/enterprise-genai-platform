import { GroundedMockProvider } from './grounded-mock.provider';
import { MockProvider } from './mock.provider';
import { openStream, streamFromResult } from './streaming';
import type { ChatResult, LlmProvider, StreamEvent } from './types';

const result: ChatResult = {
  message: { role: 'assistant', content: 'Refunds take five days.' },
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  provider: 'p',
};
const drain = async (events: AsyncGenerator<StreamEvent, void, void>) => {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};
const request = { messages: [{ role: 'user' as const, content: 'refunds?' }] };

describe('streaming', () => {
  it('plays an answer back a few words at a time, then closes with the facts', async () => {
    const events = await drain(streamFromResult(result));

    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : []));
    expect(text.join('')).toBe('Refunds take five days.');
    expect(text.length).toBeGreaterThan(1);
    expect(events.at(-1)).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: result.usage,
      provider: 'p',
    });
  });

  it('streams an empty answer as just the closing event', async () => {
    const events = await drain(
      streamFromResult({ ...result, message: { role: 'assistant', content: '' } }),
    );

    expect(events.map((e) => e.type)).toEqual(['done']);
  });

  it('stops when told to, without sending the rest', async () => {
    const abort = new AbortController();
    const events: StreamEvent[] = [];

    for await (const event of streamFromResult(result, 5, abort.signal)) {
      events.push(event);
      abort.abort();
    }

    expect(events).toHaveLength(1);
  });

  it('plays a provider with no streaming of its own back from its whole answer', async () => {
    const plain: LlmProvider = { name: 'plain', chat: () => Promise.resolve(result) };

    const events = await drain(openStream(plain, request));

    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((e) => e.type === 'delta')).toBe(true);
  });

  it('streams the mock providers, and a grounded answer keeps its citation marker', async () => {
    const echo = await drain(new MockProvider().chatStream(request));
    expect(echo.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')).toBe(
      'echo: refunds?',
    );

    const grounded = new GroundedMockProvider();
    const answer = await drain(
      grounded.chatStream({
        messages: [
          {
            role: 'system',
            content: '[1] Refunds\nRefunds take five working days.\n\nQuestion: x',
          },
          { role: 'user', content: 'How long do refunds take?' },
        ],
      }),
    );
    const text = answer.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toMatch(/five working days.*\[1\]/);
  });

  it('delays pieces by the configured amount, so time to first token is measurable', async () => {
    const provider = new MockProvider({ streamDelayMs: 30 });
    const started = Date.now();

    const stream = provider.chatStream(request);
    await stream.next();

    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    await stream.return(undefined);
  });
});
