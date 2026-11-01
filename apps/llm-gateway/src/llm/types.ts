export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  /** Model-generated assistant message. */
  message: ChatMessage;
  finishReason: string;
  usage: Usage;
  /** Which deployment actually served this request (matters once fallback kicks in). */
  provider: string;
}

/** What a streamed answer is made of: pieces of text, then one closing event with the facts. */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason: string; usage: Usage; provider: string };

/** One concrete upstream: a single Azure OpenAI deployment, or the mock. */
export interface LlmProvider {
  readonly name: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  /**
   * The same call, delivered as it is generated. Optional: a provider without it is played back
   * from its whole answer, so nothing else needs to know the difference.
   */
  chatStream?(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void>;
}

export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');
