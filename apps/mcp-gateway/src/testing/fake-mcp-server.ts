import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeToolContext {
  /** Whatever `authenticate` returned for this request's bearer token. */
  identity: unknown;
}

export interface FakeTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /** The `content` blocks to return, or throw to produce a JSON-RPC error. */
  handler?: (args: Record<string, unknown>, ctx: FakeToolContext) => unknown[] | Promise<unknown[]>;
  /** Return `isError: true` with this text. */
  failWith?: string;
}

export interface FakeMcpOptions {
  tools: FakeTool[];
  /** Reply as a server-sent event stream instead of plain JSON. */
  sse?: boolean;
  /** Serve tools/list in pages of this size, to exercise pagination. */
  pageSize?: number;
  /** When set, every request needs a bearer token this accepts (throw to reject). */
  authenticate?: (bearer: string) => Promise<unknown> | unknown;
  /** Delay every response, to exercise timeouts. */
  delayMs?: number;
  /** Reply with a body this big to every tools/call, to exercise size caps. */
  oversizeBytes?: number;
}

export interface SeenRequest {
  method: string;
  bearer: string | undefined;
  sessionId: string | undefined;
}

/**
 * A small but real MCP server over Streamable HTTP (initialize, tools/list, tools/call), for tests
 * and the demo. Its tools can be swapped at any time, which is how a test plays a server that
 * changes a tool's description after it was approved.
 */
export class FakeMcpServer {
  readonly seen: SeenRequest[] = [];
  private server: http.Server | undefined;
  private readonly sessions = new Set<string>();
  url = '';

  constructor(private options: FakeMcpOptions) {}

  get tools(): FakeTool[] {
    return this.options.tools;
  }

  setTools(tools: FakeTool[]): void {
    this.options = { ...this.options, tools };
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}/mcp`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.closeAllConnections();
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown>; cursor?: string };
    };

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    this.seen.push({ method: message.method, bearer, sessionId });
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));

    let identity: unknown;
    if (this.options.authenticate) {
      try {
        identity = await this.options.authenticate(bearer ?? '');
      } catch {
        res.writeHead(401).end();
        return;
      }
    }

    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      this.send(res, message.id, { result }, headers);
    const fail = (code: number, text: string) =>
      this.send(res, message.id, { error: { code, message: text } });

    if (message.method === 'initialize') {
      const id = randomUUID();
      this.sessions.add(id);
      return reply(
        {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        },
        { 'mcp-session-id': id },
      );
    }
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.writeHead(400).end();
      return;
    }
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }

    if (message.method === 'tools/list') {
      const size = this.options.pageSize ?? this.options.tools.length;
      const start = Number(message.params?.cursor ?? 0);
      const page = this.options.tools.slice(start, start + size);
      return reply({
        tools: page.map((t) => ({
          name: t.name,
          description: t.description,
          ...(t.inputSchema && { inputSchema: t.inputSchema }),
        })),
        ...(start + size < this.options.tools.length && { nextCursor: String(start + size) }),
      });
    }

    if (message.method === 'tools/call') {
      const tool = this.options.tools.find((t) => t.name === message.params?.name);
      if (!tool) return fail(-32602, 'Unknown tool');
      if (this.options.oversizeBytes) {
        return reply({ content: [{ type: 'text', text: 'x'.repeat(this.options.oversizeBytes) }] });
      }
      if (tool.failWith) {
        return reply({ content: [{ type: 'text', text: tool.failWith }], isError: true });
      }
      try {
        const content = (await tool.handler?.(message.params?.arguments ?? {}, { identity })) ?? [
          { type: 'text', text: 'ok' },
        ];
        return reply({ content });
      } catch (error) {
        return fail(-32000, String(error));
      }
    }
    return fail(-32601, 'Method not found');
  }

  private send(
    res: http.ServerResponse,
    id: number | undefined,
    payload: { result?: unknown; error?: unknown },
    headers: Record<string, string> = {},
  ): void {
    const body = JSON.stringify({ jsonrpc: '2.0', id, ...payload });
    if (this.options.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      res.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n` +
          `event: message\ndata: ${body}\n\n`,
      );
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(body);
    }
  }
}
