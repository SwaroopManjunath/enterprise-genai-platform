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

/** A tool the MCP gateway says this user may call. */
export interface McpToolView {
  id: string;
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: 'read' | 'write';
}

export interface McpCallResult {
  content: string;
  isError: boolean;
  withheld: boolean;
  truncated: boolean;
  redacted: boolean;
}

/** The MCP gateway decides which tools this token's user may see and call. */
export class McpGatewayClient {
  constructor(private readonly http: HttpJsonClient) {}

  async listTools(token: string, requestId: string): Promise<McpToolView[]> {
    const response = await this.http.get<{ tools: McpToolView[] }>('/v1/tools', token, {
      'x-request-id': requestId,
    });
    return response.tools;
  }

  call(
    token: string,
    input: { server: string; tool: string; arguments: Record<string, unknown> },
    requestId: string,
  ): Promise<McpCallResult> {
    return this.http.post<McpCallResult>('/v1/tools/call', token, input, {
      'x-request-id': requestId,
    });
  }
}
