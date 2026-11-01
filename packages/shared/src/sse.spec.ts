import { formatSse, parseSse, type SseMessage } from './sse';

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};
const collect = async (body: ReadableStream<Uint8Array>): Promise<SseMessage[]> => {
  const out: SseMessage[] = [];
  for await (const message of parseSse(body)) out.push(message);
  return out;
};

describe('sse', () => {
  it('formats an event the way a client expects', () => {
    expect(formatSse('delta', { text: 'hi' })).toBe('event: delta\ndata: {"text":"hi"}\n\n');
  });

  it('parses events, with and without a name', async () => {
    const messages = await collect(streamOf('event: delta\ndata: {"a":1}\n\ndata: plain\n\n'));

    expect(messages).toEqual([{ event: 'delta', data: '{"a":1}' }, { data: 'plain' }]);
  });

  it('copes with events split across chunks, even mid-line and mid-character', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('event: delta\ndata: {"t":"café"}\n\n');
    const split = bytes.length - 8; // inside the multi-byte "é" region of the payload
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });

    expect(await collect(body)).toEqual([{ event: 'delta', data: '{"t":"café"}' }]);
  });

  it('handles several events in one chunk, CRLF line ends, comments and multi-line data', async () => {
    const messages = await collect(
      streamOf(': keep-alive\r\n\r\ndata: one\r\n\r\ndata: two\ndata: three\n\n'),
    );

    expect(messages).toEqual([{ data: 'one' }, { data: 'two\nthree' }]);
  });

  it('delivers a final event that has no closing blank line', async () => {
    expect(await collect(streamOf('data: last'))).toEqual([{ data: 'last' }]);
  });

  it('stops reading when the consumer quits early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('data: x\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const message of parseSse(body)) {
      expect(message.data).toBe('x');
      break;
    }

    expect(cancelled).toBe(true);
  });
});
