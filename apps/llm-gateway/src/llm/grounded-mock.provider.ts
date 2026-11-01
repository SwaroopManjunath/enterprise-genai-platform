import { streamFromResult } from './streaming';
import { estimateTokens } from './tokens';
import type { ChatRequest, ChatResult, LlmProvider, StreamEvent } from './types';

const STOPWORDS = new Set(
  'the and are for you your what when where which who how does did can has have was were with from that this will about into than then them they their there'.split(
    ' ',
  ),
);

interface ParsedSource {
  marker: number;
  body: string;
}

/** Reads "[1] heading\ntext\n\n[2] heading\ntext" blocks out of the system prompt. */
export function parseSources(prompt: string): ParsedSource[] {
  const headers = [...prompt.matchAll(/^\[(\d{1,3})\][^\n]*$/gm)];
  return headers.map((header, i) => {
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[i + 1]?.index ?? prompt.length;
    const body = prompt
      .slice(start, end)
      .split(/\n\s*Question:/)[0] // the last block must not swallow the question line
      ?.split('\n')
      .filter((line) => !line.trimStart().startsWith('#')) // chunk text may start with its heading
      .join('\n')
      .trim();
    return { marker: Number(header[1]), body: body ?? '' };
  });
}

const words = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));

/** Word forms count as a match (refund / refunds / refunding): shared 4+ character prefix. */
const sameWord = (a: string, b: string): boolean =>
  a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));

/**
 * Deterministic stand-in for a well-behaved model, so the whole assistant path can be run and
 * tested without a real LLM. It does what the prompt asks of a model: answer only from the numbered
 * sources, cite the one it used as [n], and say it does not know when nothing matches.
 *
 * This is a test double, not a language model: it quotes the first sentence of the best-matching
 * source. Real answer quality is the job of Azure OpenAI and, later, the evaluation pipeline.
 */
export class GroundedMockProvider implements LlmProvider {
  readonly name = 'mock-grounded';
  calls = 0;
  /** Pause between streamed pieces, to make time-to-first-token measurable. */
  streamDelayMs = 0;

  /** Goes through `chat`, so a subclass that changes the answer changes the stream with it. */
  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, void> {
    yield* streamFromResult(await this.chat(request), this.streamDelayMs, signal);
  }

  chat(request: ChatRequest): Promise<ChatResult> {
    this.calls += 1;

    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const question = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const reply = this.answer(question, parseSources(system));

    const promptTokens = estimateTokens(request.messages.map((m) => m.content).join(' '));
    const completionTokens = estimateTokens(reply);
    return Promise.resolve({
      message: { role: 'assistant', content: reply },
      finishReason: 'stop',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      provider: this.name,
    });
  }

  private answer(question: string, sources: ParsedSource[]): string {
    const queryWords = [...new Set(words(question))];

    let best: { source: ParsedSource; overlap: number } | undefined;
    for (const source of sources) {
      const bodyWords = words(source.body);
      const overlap = queryWords.filter((q) => bodyWords.some((b) => sameWord(q, b))).length;
      if (overlap > (best?.overlap ?? 0)) best = { source, overlap };
    }
    if (!best) return 'I do not know based on the provided sources.';

    const sentence =
      best.source.body
        .split(/(?<=[.!?])\s+/)[0]
        ?.replace(/\s+/g, ' ')
        .trim() ?? '';
    return `${sentence.slice(0, 300)} [${best.source.marker}]`;
  }
}
