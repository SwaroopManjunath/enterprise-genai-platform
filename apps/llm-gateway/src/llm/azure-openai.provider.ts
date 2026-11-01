import { parseSse } from '@genai/shared';
import type { ResolvedAzureDeployment } from '../config/config';
import { ProviderError } from './provider-error';
import type { ChatRequest, ChatResult, LlmProvider, StreamEvent } from './types';

interface AzureChatCompletion {
  choices?: { message?: { role?: string; content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface AzureStreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

type FetchLike = typeof fetch;

/** One Azure OpenAI deployment, called over its REST API. */
export class AzureOpenAiProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly config: ResolvedAzureDeployment,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.name = config.name;
  }

  /**
   * The same call, read as it is generated. A stream that goes quiet for the timeout is cut (the
   * limit is per silence, not per answer, so a long answer is not killed for being long), and
   * stopping early closes the connection so the deployment stops generating, and billing, at once.
   */
  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, void> {
    const { endpoint, deployment, apiVersion, apiKey } = this.config;
    const url =
      `${endpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}` +
      `/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), this.timeoutMs);
    };

    arm();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            messages: request.messages,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: combined,
        });
      } catch (cause) {
        throw new ProviderError(this.name, 'upstream request failed or timed out', { cause });
      }
      if (!response.ok) {
        throw new ProviderError(this.name, `upstream returned ${response.status}`, {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        });
      }
      if (!response.body) {
        throw new ProviderError(this.name, 'upstream returned no stream', { status: 502 });
      }

      let finishReason = 'unknown';
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      try {
        for await (const message of parseSse(response.body)) {
          arm();
          if (message.data === '[DONE]') break;
          let chunk: AzureStreamChunk;
          try {
            chunk = JSON.parse(message.data) as AzureStreamChunk;
          } catch {
            throw new ProviderError(this.name, 'upstream sent a malformed stream', { status: 502 });
          }
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
            };
          }
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(this.name, 'upstream stream failed or went quiet', {
          cause: error,
        });
      }
      yield { type: 'done', finishReason, usage, provider: this.name };
    } finally {
      clearTimeout(idle);
      controller.abort();
    }
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
