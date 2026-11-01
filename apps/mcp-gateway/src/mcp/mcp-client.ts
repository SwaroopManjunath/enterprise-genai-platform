import { z } from 'zod';
import { UpstreamError } from '../domain/errors';
import type { Transport, TransportResponse } from '../egress/guarded-transport';

export interface RawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RawToolResult {
  content: unknown[];
  isError: boolean;
}

export interface Upstream {
  url: string;
  /** Sent as a bearer token when present. */
  bearer?: string;
}

const PROTOCOL_VERSION = '2025-06-18';
const MAX_LIST_PAGES = 10;

const rpcEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const initializeResult = z.object({ protocolVersion: z.string() }).passthrough();

const listResult = z.object({
  tools: z.array(
    z
      .object({
        name: z.string(),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  ),
  nextCursor: z.string().optional(),
});

const callResult = z.object({
  content: z.array(z.unknown()).default([]),
  isError: z.boolean().optional(),
});

/** Reads the JSON-RPC message with this id out of a JSON body or a server-sent event stream. */
function findResponse(response: TransportResponse, id: number): z.infer<typeof rpcEnvelope> {
  const type = String(response.headers['content-type'] ?? '');
  const payloads: unknown[] = [];

  try {
    if (type.includes('text/event-stream')) {
      for (const event of response.body.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) payloads.push(JSON.parse(data));
      }
    } else {
      const parsed: unknown = JSON.parse(response.body);
      payloads.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  } catch {
    throw new UpstreamError('protocol', 'response is not valid JSON');
  }

  for (const payload of payloads) {
    const envelope = rpcEnvelope.safeParse(payload);
    if (envelope.success && envelope.data.id === id) return envelope.data;
  }
  throw new UpstreamError('protocol', 'no response to the request');
}

/**
 * A minimal MCP client over Streamable HTTP: initialize, list tools, call a tool. Each operation
 * opens its own short session (initialize, `initialized`, the request), so the gateway holds no
 * per-server connection state and a restarted gateway or server cannot leave a stale session
 * behind. The cost is two extra round trips per operation.
 */
export class McpClient {
  constructor(
    private readonly transport: Transport,
    private readonly limits: { timeoutMs: number; maxBytes: number },
  ) {}

  async listTools(upstream: Upstream): Promise<RawTool[]> {
    const session = await this.open(upstream);
    const tools: RawTool[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.request(upstream, session, 'tools/list', cursor ? { cursor } : {});
      const parsed = listResult.safeParse(result);
      if (!parsed.success) throw new UpstreamError('protocol', 'malformed tools/list result');
      for (const t of parsed.data.tools) {
        tools.push({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object' },
        });
      }
      cursor = parsed.data.nextCursor;
      if (!cursor) return tools;
    }
    throw new UpstreamError('protocol', `tool list longer than ${MAX_LIST_PAGES} pages`);
  }

  async callTool(
    upstream: Upstream,
    name: string,
    args: Record<string, unknown>,
  ): Promise<RawToolResult> {
    const session = await this.open(upstream);
    const result = await this.request(upstream, session, 'tools/call', { name, arguments: args });
    const parsed = callResult.safeParse(result);
    if (!parsed.success) throw new UpstreamError('protocol', 'malformed tools/call result');
    return { content: parsed.data.content, isError: parsed.data.isError ?? false };
  }

  private headers(upstream: Upstream, session?: Session): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(upstream.bearer && { authorization: `Bearer ${upstream.bearer}` }),
      ...(session?.id && { 'mcp-session-id': session.id }),
      ...(session && { 'mcp-protocol-version': session.protocolVersion }),
    };
  }

  private async send(
    upstream: Upstream,
    body: unknown,
    session?: Session,
  ): Promise<TransportResponse> {
    const response = await this.transport.post(upstream.url, {
      headers: this.headers(upstream, session),
      body: JSON.stringify(body),
      timeoutMs: this.limits.timeoutMs,
      maxBytes: this.limits.maxBytes,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError('http', `status ${response.status}`);
    }
    return response;
  }

  private async open(upstream: Upstream): Promise<Session> {
    const response = await this.send(upstream, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'genai-mcp-gateway', version: '0.1.0' },
      },
    });
    const envelope = findResponse(response, 1);
    if (envelope.error)
      throw new UpstreamError('protocol', `initialize failed (${envelope.error.code})`);
    const init = initializeResult.safeParse(envelope.result);
    if (!init.success) throw new UpstreamError('protocol', 'malformed initialize result');

    const id = response.headers['mcp-session-id'];
    const session: Session = {
      protocolVersion: init.data.protocolVersion,
      ...(typeof id === 'string' && { id }),
    };
    await this.send(upstream, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    return session;
  }

  private async request(
    upstream: Upstream,
    session: Session,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.send(upstream, { jsonrpc: '2.0', id: 2, method, params }, session);
    const envelope = findResponse(response, 2);
    if (envelope.error) {
      // The server's own message is not forwarded: it is untrusted text.
      throw new UpstreamError('protocol', `${method} failed (code ${envelope.error.code})`);
    }
    return envelope.result;
  }
}

interface Session {
  id?: string;
  protocolVersion: string;
}
