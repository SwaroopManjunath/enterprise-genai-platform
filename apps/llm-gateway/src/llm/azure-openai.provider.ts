import type { AzureDeploymentConfig } from '../config/config';
import { ProviderError } from './provider-error';
import type { ChatRequest, ChatResult, LlmProvider } from './types';

interface AzureChatCompletion {
  choices?: { message?: { role?: string; content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

type FetchLike = typeof fetch;

/** One Azure OpenAI deployment, called over its REST API. */
export class AzureOpenAiProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly config: AzureDeploymentConfig,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.name = config.name;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const { endpoint, deployment, apiVersion, apiKey } = this.config;
    const url =
      `${endpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}` +
      `/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          messages: request.messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
        signal: combined,
      });
    } catch (cause) {
      // Network error or timeout: no status, so classified as retryable + fallbackable.
      throw new ProviderError(this.name, 'upstream request failed or timed out', { cause });
    }

    if (!response.ok) {
      throw new ProviderError(this.name, `upstream returned ${response.status}`, {
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }

    const body = (await response.json()) as AzureChatCompletion;
    const choice = body.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError(this.name, 'upstream returned no completion', { status: 502 });
    }

    const usage = body.usage ?? {};
    return {
      message: { role: 'assistant', content: choice.message.content ?? '' },
      finishReason: choice.finish_reason ?? 'unknown',
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      },
      provider: this.name,
    };
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
