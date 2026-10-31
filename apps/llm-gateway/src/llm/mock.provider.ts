import { ProviderError } from './provider-error';
import type { ChatRequest, ChatResult, LlmProvider } from './types';

export interface MockProviderOptions {
  name?: string;
  /** Called per request; throw a ProviderError to simulate an upstream failure. */
  behavior?: (request: ChatRequest, callNumber: number) => void | Promise<void>;
}

/** Deterministic provider for local dev and tests: echoes the last user message. */
export class MockProvider implements LlmProvider {
  readonly name: string;
  calls = 0;

  constructor(private readonly options: MockProviderOptions = {}) {
    this.name = options.name ?? 'mock';
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    await this.options.behavior?.(request, this.calls);

    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const reply = `echo: ${lastUser?.content ?? ''}`;
    const promptTokens = estimateTokens(request.messages.map((m) => m.content).join(' '));
    const completionTokens = estimateTokens(reply);

    return {
      message: { role: 'assistant', content: reply },
      finishReason: 'stop',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      provider: this.name,
    };
  }
}

/** Rough heuristic (~4 chars per token); real counts come from the upstream usage field. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function failing(status: number | undefined, name = 'mock'): MockProviderOptions {
  return {
    name,
    behavior: () => {
      throw new ProviderError(name, 'simulated failure', status === undefined ? {} : { status });
    },
  };
}
