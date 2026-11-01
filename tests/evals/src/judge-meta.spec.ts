import { LexicalJudge } from './judge';
import { loadMetaExamples, measureJudge } from './judge-meta';

describe('judge meta-evaluation', () => {
  const examples = loadMetaExamples();

  it('has a labelled set with both kinds of answer, and the known misses marked', () => {
    expect(examples.length).toBeGreaterThanOrEqual(20);
    expect(examples.filter((e) => e.grounded && !e.knownMiss).length).toBeGreaterThanOrEqual(6);
    expect(examples.filter((e) => !e.grounded && !e.knownMiss).length).toBeGreaterThanOrEqual(8);
    expect(examples.filter((e) => e.knownMiss).length).toBeGreaterThanOrEqual(3);
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
  });

  it('the lexical judge agrees with a person on every example it is expected to get right', async () => {
    const result = await measureJudge(new LexicalJudge(), examples);

    expect(result.wrong).toEqual([]);
    expect(result.accuracy).toBe(1);
  });

  it('still misses what it is known to miss, so the list of limits is honest', async () => {
    const result = await measureJudge(new LexicalJudge(), examples);

    // If this fails the judge got better: move the example out of knownMiss and celebrate.
    expect(result.nowRight).toEqual([]);
    expect(result.stillMissed.sort()).toEqual(['recombined', 'rephrased', 'swapped-subject']);
  });

  it('notices a judge that is broken: one that approves everything scores badly', async () => {
    const yesMan = {
      name: 'yes-man',
      groundedness: () => Promise.resolve({ score: 1, claims: [] }),
    };

    const result = await measureJudge(yesMan, examples);

    expect(result.accuracy).toBeLessThan(0.5);
    expect(result.wrong).toContain('invented-claim');
  });

  it('notices a judge that rejects everything too', async () => {
    const noMan = { name: 'no-man', groundedness: () => Promise.resolve({ score: 0, claims: [] }) };

    const result = await measureJudge(noMan, examples);

    // a judge that never approves scores only the share of examples that really are ungrounded
    expect(result.accuracy).toBeLessThan(0.7);
    expect(result.wrong).toContain('restate');
  });
});
