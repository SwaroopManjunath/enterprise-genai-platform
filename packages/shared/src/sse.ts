export interface SseMessage {
  /** The `event:` field; absent for the default `message` event. */
  event?: string;
  /** The `data:` lines joined with newlines. */
  data: string;
}

/** One server-sent event, ready to write to a response. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Reads server-sent events from a response body. Events are separated by a blank line and may
 * arrive split across chunks or several to a chunk; comments (lines starting with `:`) are ignored.
 * A trailing event without its blank line is delivered when the stream ends.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const toMessage = (block: string): SseMessage | undefined => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':') || line === '') continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length === 0
      ? undefined
      : { ...(event !== undefined && { event }), data: data.join('\n') };
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const message = toMessage(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    const last = toMessage(buffer);
    if (last) yield last;
  } finally {
    // Stops reading (and, for a network body, lets the connection close) if the consumer quits early.
    await reader.cancel().catch(() => undefined);
  }
}
