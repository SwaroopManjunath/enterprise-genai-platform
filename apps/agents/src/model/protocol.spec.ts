import { ModelProtocolError, parseModelReply } from './protocol';

describe('parseModelReply', () => {
  it('reads a final answer', () => {
    expect(parseModelReply('{"final":"Done."}')).toEqual({ kind: 'final', answer: 'Done.' });
  });

  it('reads tool calls, with the reason and defaulted arguments', () => {
    expect(
      parseModelReply(
        '{"reason":"look it up","calls":[{"name":"get_ticket","arguments":{"id":"T-1"}},{"name":"x"}]}',
      ),
    ).toEqual({
      kind: 'calls',
      reason: 'look it up',
      calls: [
        { name: 'get_ticket', arguments: { id: 'T-1' } },
        { name: 'x', arguments: {} },
      ],
    });
  });

  it('tolerates one code fence, the single allowance', () => {
    expect(parseModelReply('```json\n{"final":"ok"}\n```')).toEqual({
      kind: 'final',
      answer: 'ok',
    });
    expect(parseModelReply('```\n{"final":"ok"}\n```')).toEqual({ kind: 'final', answer: 'ok' });
  });

  it.each([
    ['prose around the json', 'Sure! {"final":"x"} hope that helps'],
    ['plain text', 'I will now search the documents.'],
    ['empty', ''],
    ['both shapes at once', '{"final":"x","calls":[{"name":"a"}]}'],
    ['empty calls', '{"calls":[]}'],
    ['extra field on the envelope', '{"final":"x","approved":true}'],
    ['extra field on a call', '{"calls":[{"name":"a","arguments":{},"approved":true}]}'],
    ['arguments not an object', '{"calls":[{"name":"a","arguments":"rm -rf"}]}'],
    ['empty final', '{"final":""}'],
    ['a json array', '[{"final":"x"}]'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseModelReply(raw)).toThrow(ModelProtocolError);
  });

  it('rejects an oversized reply before parsing it', () => {
    expect(() => parseModelReply(`{"final":"${'a'.repeat(30_000)}"}`)).toThrow(/too long/);
  });
});
