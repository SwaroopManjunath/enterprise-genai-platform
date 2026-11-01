import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GroundedMockProvider } from '../../../apps/llm-gateway/src/llm/grounded-mock.provider';

/**
 * A stand-in for the Azure OpenAI REST API, so the real-model harnesses can be tried (and tested)
 * without spending anything: same URL shape, same `api-key` check, same response and streaming
 * formats. It answers from the numbered sources like the grounded mock, and grades claims as a
 * generous judge would. It is not a model, and says nothing about one.
 */
export interface FakeAzure {
  url: string;
  requests: { deployment: string; judge: boolean; stream: boolean }[];
  close(): Promise<void>;
}

const mock = new GroundedMockProvider();

export async function startFakeAzure(
  apiKey: string,
  port = 0,
  host = '127.0.0.1',
): Promise<FakeAzure> {
  const requests: FakeAzure['requests'] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const match = /^\/openai\/deployments\/([^/]+)\/chat\/completions/.exec(req.url ?? '');
      if (req.method !== 'POST' || !match) {
        res.statusCode = 404;
        return res.end();
      }
      if (req.headers['api-key'] !== apiKey) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { code: 'Unauthorized' } }));
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
        stream?: boolean;
      };
      const prompt = body.messages.map((m) => m.content).join('\n');
      const judge = prompt.includes('<claims>');
      requests.push({ deployment: match[1] as string, judge, stream: Boolean(body.stream) });

      let content: string;
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (judge) {
        const count = (prompt.match(/^\d+\. /gm) ?? []).length;
        content = JSON.stringify(Array.from({ length: count }, () => true));
        usage = { prompt_tokens: 100, completion_tokens: count, total_tokens: 100 + count };
      } else {
        const result = await mock.chat({ messages: body.messages });
        content = result.message.content;
        usage = {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        };
      }

      if (!body.stream) {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage,
          }),
        );
      }
      res.setHeader('content-type', 'text/event-stream');
      for (const word of content.split(/(?<=\s)/)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (require.main === module) {
  void startFakeAzure(
    process.env['AZURE_OPENAI_API_KEY'] ?? 'fake-key',
    Number(process.env['PORT'] ?? 4010),
    process.env['HOST'] ?? '127.0.0.1',
  ).then((f) => {
    console.log(`fake Azure OpenAI on ${f.url} (api key: AZURE_OPENAI_API_KEY or "fake-key")`);
  });
}
