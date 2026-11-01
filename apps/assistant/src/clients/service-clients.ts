import { DownstreamError, type HttpJsonClient } from '@genai/shared';

export interface SearchHit {
  chunkId: string;
  documentId: string;
  text: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface SearchRequest {
  query: string;
  topK: number;
  filter?: { documentIds?: string[]; tags?: string[] };
}

/** Retrieval returns only what the token's tenant and roles may see: trimming happens there. */
export class RetrievalClient {
  constructor(private readonly http: HttpJsonClient) {}

  async search(token: string, request: SearchRequest, requestId: string): Promise<SearchHit[]> {
    const response = await this.http.post<{ results: SearchHit[] }>(
      '/v1/search',
      token,
      { ...request, mode: 'hybrid', rerank: true },
      { 'x-request-id': requestId },
    );
    return response.results;
  }
}

export interface ResolvedPrompt {
  version: number;
  rendered: string;
}

export class PromptClient {
  constructor(private readonly http: HttpJsonClient) {}

  resolve(
    token: string,
    name: string,
    input: { variables: Record<string, string>; subjectKey: string },
    requestId: string,
  ): Promise<ResolvedPrompt> {
    return this.http.post<ResolvedPrompt>(
      `/v1/prompts/${encodeURIComponent(name)}/resolve`,
      token,
      input,
      { 'x-request-id': requestId },
    );
  }
}

export interface ChatCompletion {
  message: { role: string; content: string };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  provider: string;
  fallbackUsed: boolean;
  /** What the call cost, as priced by the gateway. Absent from gateways that predate cost tracking. */
  cost?: { microUsd: number; priced: boolean };
}

/** What the gateway sends while an answer is generated. */
export type GatewayStreamEvent =
  | { type: 'delta'; text: string; provider: string; fallbackUsed: boolean }
  | {
      type: 'done';
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      provider: string;
      fallbackUsed: boolean;
      cost?: { microUsd: number; priced: boolean };
    };

export class GatewayClient {
  constructor(private readonly http: HttpJsonClient) {}

  chat(
    token: string,
    messages: { role: 'system' | 'user'; content: string }[],
    requestId: string,
  ): Promise<ChatCompletion> {
    return this.http.post<ChatCompletion>(
      '/v1/chat/completions',
      token,
      { messages },
      { 'x-request-id': requestId },
    );
  }

  /**
   * The same call, as it is generated. An error status before the first event rejects like `chat`
   * does; an `error` event after that throws, since the answer is then incomplete.
   */
  async *chatStream(
    token: string,
    messages: { role: 'system' | 'user'; content: string }[],
    requestId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GatewayStreamEvent, void, void> {
    for await (const message of this.http.postEventStream(
      '/v1/chat/completions',
      token,
      { messages, stream: true },
      { 'x-request-id': requestId },
      signal,
    )) {
      const data = JSON.parse(message.data) as Record<string, unknown>;
      if (message.event === 'delta') {
        yield {
          type: 'delta',
          text: String(data['text']),
          provider: String(data['provider']),
          fallbackUsed: data['fallbackUsed'] === true,
        };
      } else if (message.event === 'done') {
        yield {
          type: 'done',
          usage: data['usage'] as Extract<GatewayStreamEvent, { type: 'done' }>['usage'],
          provider: String(data['provider']),
          fallbackUsed: data['fallbackUsed'] === true,
          ...(data['cost'] !== undefined && {
            cost: data['cost'] as { microUsd: number; priced: boolean },
          }),
        };
      } else if (message.event === 'error') {
        throw new DownstreamError('gateway', 'http', 502, String(data['code'] ?? 'stream_error'));
      }
    }
  }
}
