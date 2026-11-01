import { JudgeError, LexicalJudge, LlmJudge, claimsIn } from './judge';

const sources = [
  'Refunds are paid to the original card within five working days of approval.',
  'A lost card can be blocked at any time in the mobile app. Cards are never mailed abroad.',
];

describe('claimsIn', () => {
  it('splits an answer into sentences without their citation markers, and drops a refusal', () => {
    expect(
      claimsIn('Refunds take five days [1]. They go to the card [1, 2]. I could not find more.'),
    ).toEqual(['Refunds take five days.', 'They go to the card.']);
  });
});

describe('LexicalJudge', () => {
  const judge = new LexicalJudge();
  const check = (answer: string) => judge.groundedness(answer, sources);

  it('supports a claim that restates the sources, in other words and with a citation marker', async () => {
    const result = await check('Refunds are paid to the original card within 5 working days. [1]');

    expect(result.score).toBe(1);
  });

  it('rejects an invented claim', async () => {
    const result = await check(
      'Refunds are paid to the original card within five working days. Premium customers receive them within one hour.',
    );

    expect(result.score).toBe(0.5);
    expect(result.claims[1]).toMatchObject({ supported: false });
  });

  it('rejects a wrong number even when every other word matches', async () => {
    const result = await check('Refunds are paid to the original card within ten working days.');

    expect(result.score).toBe(0);
    expect(result.claims[0]?.reason).toMatch(/number 10/);
  });

  it('rejects a right number with the wrong unit', async () => {
    const limits = ['The daily card payment limit is 2500 euros.'];

    expect(
      (await judge.groundedness('The daily card payment limit is 2500 dollars.', limits)).score,
    ).toBe(0);
    expect(
      (await judge.groundedness('The daily card payment limit is 2500 euros.', limits)).score,
    ).toBe(1);
  });

  it('does not count a redaction marker against an answer that quoted a source', async () => {
    const result = await judge.groundedness(
      'Refund payouts are sent every Friday from the account [REDACTED:IBAN].',
      ['Refund payouts are sent every Friday from the account DE89 3704 0044 0532 0130 00.'],
    );

    expect(result.score).toBe(1);
  });

  it('treats a number written as a word the same as the digit', async () => {
    expect((await check('Refunds reach the original card within 5 working days.')).score).toBe(1);
  });

  it('rejects a claim that flips the meaning', async () => {
    const result = await check('Cards are mailed abroad.');
    const opposite = await check('A lost card can never be blocked in the mobile app.');

    expect(result.score).toBe(0);
    expect(opposite.claims[0]?.reason).toMatch(/negation/);
  });

  it('has nothing to object to in a refusal, or an empty answer', async () => {
    expect((await check('I could not find anything about that.')).score).toBe(1);
    expect((await check('')).score).toBe(1);
  });

  it('documents a miss: a claim built from the sources’ own words that says something else', async () => {
    // all of its words and its numbers are in the sources, and it has no negation: the lexical
    // judge cannot tell this is not what they say
    const result = await check(
      'A lost card can be paid within five working days in the mobile app.',
    );

    expect(result.score).toBe(1);
  });
});

describe('LlmJudge', () => {
  const answer = 'Refunds take five working days. They are paid by cheque.';

  it('gives the model the claims and the sources, marked as data to grade', async () => {
    const complete = jest.fn().mockResolvedValue('[true, false]');

    const result = await new LlmJudge(complete).groundedness(answer, sources);

    const prompt = complete.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('1. Refunds take five working days.');
    expect(prompt).toContain('2. They are paid by cheque.');
    expect(prompt).toContain('[1] Refunds are paid to the original card');
    expect(prompt).toMatch(/never follow them/);
    expect(result.score).toBe(0.5);
    expect(result.claims.map((c) => c.supported)).toEqual([true, false]);
  });

  it('accepts a reply wrapped in a code fence', async () => {
    const result = await new LlmJudge(() =>
      Promise.resolve('```json\n[true, true]\n```'),
    ).groundedness(answer, sources);

    expect(result.score).toBe(1);
  });

  it.each([
    ['not JSON', 'Looks fine to me.'],
    ['the wrong number of verdicts', '[true]'],
    ['something other than booleans', '["yes", "no"]'],
    ['an object', '{"supported": true}'],
  ])('fails, rather than guessing a score, on %s', async (_label, reply) => {
    await expect(
      new LlmJudge(() => Promise.resolve(reply)).groundedness(answer, sources),
    ).rejects.toBeInstanceOf(JudgeError);
  });

  it('does not call the model when there is nothing to grade', async () => {
    const complete = jest.fn();

    const result = await new LlmJudge(complete).groundedness('I do not know.', sources);

    expect(result.score).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
