import type { ChatRequest, ChatResult, LlmProvider, StreamEvent } from './types';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Plays a finished answer back as a stream, a few words at a time. Used by the test doubles and as
 * the fallback for a provider that cannot stream, so the rest of the gateway has one shape to deal
 * with.
 */
export async function* streamFromResult(
  result: ChatResult,
  delayMs = 0,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  const pieces = result.message.content.match(/\S+\s*|\s+/g) ?? [];
  for (const text of pieces) {
    if (signal?.aborted) return;
    if (delayMs > 0) await sleep(delayMs, signal);
    if (signal?.aborted) return;
    yield { type: 'delta', text };
  }
  yield {
    type: 'done',
    finishReason: result.finishReason,
    usage: result.usage,
    provider: result.provider,
  };
}

/** A provider's stream, or its whole answer played back as one when it has no streaming of its own. */
export function openStream(
  provider: LlmProvider,
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  if (provider.chatStream) return provider.chatStream(request, signal);
  return (async function* () {
    yield* streamFromResult(await provider.chat(request, signal), 0, signal);
  })();
}
