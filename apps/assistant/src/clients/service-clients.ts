import type { HttpJsonClient } from '@genai/shared';

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
}
