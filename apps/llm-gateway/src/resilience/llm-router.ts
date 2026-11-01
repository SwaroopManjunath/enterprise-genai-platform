import { ProviderError } from '../llm/provider-error';
import { openStream } from '../llm/streaming';
import type { ChatRequest, ChatResult, LlmProvider, StreamEvent } from '../llm/types';
import { withRetry, type RetryOptions } from './retry';

export interface RoutedChatResult extends ChatResult {
  /** True when the primary deployment did not serve this request. */
  fallbackUsed: boolean;
}

/** A stream event, tagged with which deployment is serving it. */
export type RoutedStreamEvent = StreamEvent & { provider: string; fallbackUsed: boolean };

export class AllProvidersFailedError extends Error {
  constructor(readonly failures: readonly ProviderError[]) {
    super(`All ${failures.length} LLM deployment(s) failed`);
    this.name = 'AllProvidersFailedError';
  }
}

/**
 * Tries deployments in preference order. Each one gets retries with backoff for transient
 * errors; if it still fails (or is misconfigured) we move to the next one. Errors that every
 * deployment would reproduce (a malformed request) are thrown straight back to the caller.
 */
export class LlmRouter {
  constructor(
    private readonly providers: readonly LlmProvider[],
    private readonly retry: RetryOptions,
    private readonly onFailure: (error: ProviderError) => void = () => undefined,
  ) {
    if (providers.length === 0) {
      throw new Error('LlmRouter needs at least one provider');
    }
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<RoutedChatResult> {
    const failures: ProviderError[] = [];

    for (const [index, provider] of this.providers.entries()) {
      try {
        const result = await withRetry(() => provider.chat(request, signal), this.retry);
        return { ...result, fallbackUsed: index > 0 };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        this.onFailure(error);
        failures.push(error);
        if (!error.fallbackable) throw error;
      }
    }

    throw new AllProvidersFailedError(failures);
  }

  /**
   * Streams an answer. Retry and fallback work exactly as for `chat`, but only up to the first
   * piece of text: once something has been sent to the caller it cannot be taken back, so a
   * deployment that fails after that point fails the stream instead of silently starting a second
   * answer after the first.
   */
  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<RoutedStreamEvent, void, void> {
    const failures: ProviderError[] = [];

    for (const [index, provider] of this.providers.entries()) {
      const tag = <T extends StreamEvent>(
        event: T,
      ): T & { provider: string; fallbackUsed: boolean } => ({
        ...event,
        provider: provider.name,
        fallbackUsed: index > 0,
      });

      let started: {
        iterator: AsyncGenerator<StreamEvent, void, void>;
        first: IteratorResult<StreamEvent, void>;
      };
      try {
        started = await withRetry(async () => {
          const iterator = openStream(provider, request, signal);
          return { iterator, first: await iterator.next() };
        }, this.retry);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        this.onFailure(error);
        failures.push(error);
        if (!error.fallbackable) throw error;
        continue;
      }

      const { iterator, first } = started;
      try {
        if (first.done) return;
        yield tag(first.value);
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield tag(next.value);
        }
      } finally {
        await iterator.return(undefined);
      }
    }

    throw new AllProvidersFailedError(failures);
  }
}
