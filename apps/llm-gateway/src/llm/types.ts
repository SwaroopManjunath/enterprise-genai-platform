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

/** One concrete upstream: a single Azure OpenAI deployment, or the mock. */
export interface LlmProvider {
  readonly name: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
}

export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');
