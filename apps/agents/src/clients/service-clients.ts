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

export interface ChatCompletion {
  message: { role: string; content: string };
  provider: string;
}

export class GatewayClient {
  constructor(private readonly http: HttpJsonClient) {}

  chat(
    token: string,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
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
