import type { GatewayClient } from '../clients/service-clients';
import { z } from 'zod';
import type { AnyTool } from '../tools/tool';
import { GatewayAgentModel, buildSystemPrompt } from './agent-model';
import { ModelProtocolError } from './protocol';

const tool = (name: string): AnyTool =>
  ({
    name,
    description: `${name} description`,
    risk: 'read',
    requiredRoles: [],
    input: z.object({}).strict(),
    parametersHelp: '{}',
    describe: () => name,
    execute: () => Promise.resolve(null),
  }) as unknown as AnyTool;

describe('GatewayAgentModel', () => {
  const gatewayReturning = (content: string) => {
    const chat = jest.fn().mockResolvedValue({ message: { role: 'assistant', content } });
    return { chat, model: new GatewayAgentModel({ chat } as unknown as GatewayClient) };
  };

  it('lists only the tools it was given in the system prompt', () => {
    const prompt = buildSystemPrompt([tool('search_documents')]);

    expect(prompt).toContain('search_documents');
    expect(prompt).not.toContain('send_email');
  });

  it('sends system prompt + transcript through the gateway with the user’s token', async () => {
    const { chat, model } = gatewayReturning('{"final":"hi"}');

    const result = await model.next({
      tools: [tool('a')],
      transcript: [{ role: 'user', content: 'goal' }],
      token: 'tok',
      requestId: 'req-1',
    });

    const [token, messages, requestId] = chat.mock.calls[0] as [
      string,
      { role: string; content: string }[],
      string,
    ];
    expect(token).toBe('tok');
    expect(requestId).toBe('req-1');
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(result.step).toEqual({ kind: 'final', answer: 'hi' });
  });

  it('uses a fresh canary per call, present in the prompt but not in the instruction text', async () => {
    const { chat, model } = gatewayReturning('{"final":"hi"}');
    const req = {
      tools: [],
      transcript: [{ role: 'user' as const, content: 'g' }],
      token: 't',
      requestId: 'r',
    };

    const a = await model.next(req);
    const b = await model.next(req);

    expect(a.outputContext.canary).not.toBe(b.outputContext.canary);
    const system = (chat.mock.calls[0] as [string, { content: string }[]])[1][0]?.content ?? '';
    expect(system).toContain(a.outputContext.canary);
    expect(a.outputContext.instructionText).not.toContain(a.outputContext.canary);
  });

  it('turns a malformed reply into a protocol error rather than guessing', async () => {
    const { model } = gatewayReturning('I think we should search.');

    await expect(
      model.next({
        tools: [],
        transcript: [{ role: 'user', content: 'g' }],
        token: 't',
        requestId: 'r',
      }),
    ).rejects.toBeInstanceOf(ModelProtocolError);
  });
});
