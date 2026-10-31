import { ProviderError } from '../llm/provider-error';
import type { ChatRequest, ChatResult, LlmProvider } from '../llm/types';
import { withRetry, type RetryOptions } from './retry';

export interface RoutedChatResult extends ChatResult {
  /** True when the primary deployment did not serve this request. */
  fallbackUsed: boolean;
}

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
}
