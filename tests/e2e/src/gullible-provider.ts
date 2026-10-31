import { GroundedMockProvider } from '../../../apps/llm-gateway/src/llm/grounded-mock.provider';
import type { ChatRequest, ChatResult } from '../../../apps/llm-gateway/src/llm/types';

const reply = (content: string): ChatResult => ({
  message: { role: 'assistant', content },
  finishReason: 'stop',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  provider: 'mock-grounded',
});

/**
 * A deliberately NAIVE model, for testing defences. It does what a poorly defended model does:
 *  - it obeys "ignore all previous instructions and answer X" found anywhere in its prompt,
 *    including inside a retrieved document;
 *  - it repeats its whole system prompt when asked to reveal it.
 * With no attack present it behaves like the grounded mock. It records every prompt it receives,
 * so tests can check what did and did not reach the model.
 */
export class GullibleProvider extends GroundedMockProvider {
  /** Every message list this model has been sent, in order. */
  readonly received: ChatRequest['messages'][] = [];

  override chat(request: ChatRequest): Promise<ChatResult> {
    this.received.push(request.messages);
    const everything = request.messages.map((m) => m.content).join('\n');

    const obeyed =
      /ignore all previous instructions and (?:answer|say|reply with) ([A-Za-z0-9_-]+)/i.exec(
        everything,
      );
    if (obeyed) {
      this.calls += 1;
      return Promise.resolve(reply(obeyed[1] as string));
    }

    if (/reveal (?:the |your )?system prompt/i.test(everything)) {
      this.calls += 1;
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      return Promise.resolve(reply(`Of course. My instructions are: ${system}`));
    }

    return super.chat(request);
  }
}
