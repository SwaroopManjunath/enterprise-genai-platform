import { GroundedMockProvider, parseSources } from './grounded-mock.provider';

const system = [
  'You answer using ONLY the sources below.',
  '',
  'Sources:',
  '[1] Pricing > Refunds',
  '# Refunds',
  'Refunds take five working days. They are sent to the original card.',
  '',
  '[2] Cards',
  'Lost cards can be blocked in the app.',
  '',
  'Question: how long do refunds take',
].join('\n');

const ask = (question: string, prompt = system) =>
  new GroundedMockProvider()
    .chat({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: question },
      ],
    })
    .then((r) => r.message.content);

describe('parseSources', () => {
  it('splits numbered blocks, drops heading lines and does not swallow the question', () => {
    const sources = parseSources(system);

    expect(sources.map((s) => s.marker)).toEqual([1, 2]);
    expect(sources[0]?.body).toBe(
      'Refunds take five working days. They are sent to the original card.',
    );
    expect(sources[1]?.body).toBe('Lost cards can be blocked in the app.');
  });

  it('returns nothing when there are no numbered sources', () => {
    expect(parseSources('just some text')).toEqual([]);
  });
});

describe('GroundedMockProvider', () => {
  it('answers from the best-matching source and cites it', async () => {
    expect(await ask('How long do refunds take?')).toBe('Refunds take five working days. [1]');
    expect(await ask('How do I block a lost card?')).toBe(
      'Lost cards can be blocked in the app. [2]',
    );
  });

  it('matches word forms (refunding ~ refunds)', async () => {
    expect(await ask('refunding')).toContain('[1]');
  });

  it('says it does not know, without a citation, when nothing matches', async () => {
    const reply = await ask('What is the capital of France?');
    expect(reply).toBe('I do not know based on the provided sources.');
    expect(reply).not.toMatch(/\[\d+\]/);
  });

  it('says it does not know when there are no sources at all', async () => {
    expect(await ask('refunds', 'no sources here')).toMatch(/do not know/);
  });

  it('reports usage and counts calls', async () => {
    const provider = new GroundedMockProvider();
    const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.provider).toBe('mock-grounded');
    expect(provider.calls).toBe(1);
  });
});
