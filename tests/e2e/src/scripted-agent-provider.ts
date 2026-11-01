import type { ChatRequest, ChatResult } from '../../../apps/llm-gateway/src/llm/types';
import { GullibleProvider } from './gullible-provider';

type Messages = ChatRequest['messages'];

/** A reply is the raw text the "model" returns, so tests can send malformed JSON too. */
export type AgentReply = string | ((messages: Messages) => string);

/** Present in the agent's system prompt and nowhere in the assistant's. */
const AGENT_PROMPT = /Reply with exactly one JSON object/;

export const calls = (...cs: { name: string; arguments?: object }[]): string =>
  JSON.stringify({ reason: 'needed for the goal', calls: cs });
export const finalAnswer = (answer: string): string => JSON.stringify({ final: answer });

/**
 * The model behind the agent in end-to-end tests. Requests from the assistant fall through to the
 * gullible grounded mock; requests from the agent get the next reply from a script, which may be a
 * function of the conversation so far. That lets a test play a model that is fooled by what it
 * reads, loops forever, or sends garbage, while everything around it is the real platform.
 */
export class ScriptedAgentProvider extends GullibleProvider {
  /** Message lists the agent sent, in order. */
  readonly agentRequests: Messages[] = [];
  private script: AgentReply[] = [];
  private position = 0;
  private repeatLast = false;

  respondWith(replies: AgentReply[], options: { repeatLast?: boolean } = {}): void {
    this.script = replies;
    this.agentRequests.length = 0;
    this.position = 0;
    this.repeatLast = options.repeatLast ?? false;
  }

  override chat(request: ChatRequest): Promise<ChatResult> {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    if (!AGENT_PROMPT.test(system)) return super.chat(request);

    this.received.push(request.messages);
    this.agentRequests.push(request.messages);
    this.calls += 1;

    const at = this.repeatLast ? Math.min(this.position, this.script.length - 1) : this.position;
    this.position += 1;
    const entry = this.script[at];
    if (entry === undefined) return Promise.reject(new Error('agent script exhausted'));
    const content = typeof entry === 'function' ? entry(request.messages) : entry;

    return Promise.resolve({
      message: { role: 'assistant', content },
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      provider: 'scripted-agent',
    });
  }
}
