import { aggregate } from './aggregate';
import type { CaseResult } from './evaluate';
import { evaluateGate, thresholdsSchema } from './gate';
import { metricIntervals, seededRandom } from './stats';

const result = (overrides: Partial<CaseResult>): CaseResult => ({
  id: 'x',
  category: 'faq',
  answerable: true,
  expectBlocked: false,
  gated: true,
  status: 'answered',
  answer: '',
  retrieval: { recall: 1, mrr: 1, leaked: [] },
  facts: { found: 1, total: 1 },
  forbiddenChecked: 0,
  forbiddenHits: [],
  citations: { precision: 1, recall: 1 },
  groundedness: 1,
  tokens: 200,
  failures: [],
  ...overrides,
});

/** `good` cases that are fully right and `bad` ones that are not, each run `runs` times. */
const cases = (good: number, bad: number, runs = 1): CaseResult[] =>
  Array.from({ length: runs }).flatMap(() => [
    ...Array.from({ length: good }, (_, i) => result({ id: `good-${i}` })),
    ...Array.from({ length: bad }, (_, i) => result({ id: `bad-${i}`, failures: ['wrong'] })),
  ]);

describe('seededRandom', () => {
  it('gives the same sequence for the same seed, and a different one for another', () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    const c = seededRandom(2);
    const first = [a(), a(), a()];

    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
  });
});

describe('metricIntervals', () => {
  it('is a single point when every case is right, and is the same every time', () => {
    const results = cases(30, 0);

    expect(metricIntervals(results).caseAccuracy).toEqual({ lower: 1, upper: 1 });
    expect(metricIntervals(results)).toEqual(metricIntervals(results));
  });

  it('brackets the observed score, and is wide for few cases and narrower for many', () => {
    const few = metricIntervals(cases(10, 10)).caseAccuracy!;
    const many = metricIntervals(cases(100, 100)).caseAccuracy!;

    expect(few.lower).toBeLessThan(0.5);
    expect(few.upper).toBeGreaterThan(0.5);
    expect(many.upper - many.lower).toBeLessThan((few.upper - few.lower) / 2);
  });

  it('does not mistake repeated runs of the same cases for more evidence', () => {
    // Three runs of the same 20 questions tell you about the model, not about 60 questions.
    const once = metricIntervals(cases(10, 10, 1)).caseAccuracy!;
    const thrice = metricIntervals(cases(10, 10, 3)).caseAccuracy!;

    expect(thrice).toEqual(once);
  });

  it('measures how much cases differ from each other: narrower when every case behaves alike', () => {
    // half the questions always right and half always wrong, against 20 questions each right in two of three runs
    const consistent = cases(10, 10, 3);
    const flaky = Array.from({ length: 3 }).flatMap((_, run) =>
      Array.from({ length: 20 }, (_, i) =>
        result({ id: `c-${i}`, failures: i % 3 === run ? ['wrong'] : [] }),
      ),
    );

    const spread = (r: CaseResult[]) => {
      const { lower, upper } = metricIntervals(r).caseAccuracy!;
      return upper - lower;
    };
    expect(aggregate(flaky).metrics.caseAccuracy).toBeCloseTo(2 / 3, 1);
    expect(spread(flaky)).toBeLessThan(spread(consistent));
  });

  it('leaves out a metric no case applies to', () => {
    expect(
      metricIntervals(cases(10, 0).map((r) => ({ ...r, answerable: false }))).answerRate,
    ).toBeUndefined();
  });
});

describe('the gate with a confidence interval', () => {
  const thresholds = thresholdsSchema.parse({
    metrics: { caseAccuracy: { min: 0.8 }, forbiddenRate: { max: 0 } },
    judgeAccuracy: { min: 0.9 },
    minCases: { total: 5, perCategory: 1 },
    informationalCategories: {},
    regression: { absolute: 0.02, relativeCost: 0.05 },
    confidence: { level: 0.95 },
  });
  const input = (results: CaseResult[]) => ({
    aggregates: aggregate(results),
    categories: { faq: { cases: 5, passed: 5 } },
    judgeAccuracy: 1,
    thresholds,
    baseline: undefined,
    intervals: metricIntervals(results),
  });
  const failed = (g: ReturnType<typeof evaluateGate>) =>
    g.checks.filter((c) => !c.passed).map((c) => c.name);

  it('fails a score whose average clears the floor but whose lower bound does not', () => {
    // 85% on 20 cases looks fine; on 20 cases it could easily be 65%.
    const results = cases(17, 3);

    expect(aggregate(results).metrics.caseAccuracy).toBeCloseTo(0.85);
    const gate = evaluateGate(input(results));
    expect(failed(gate)).toContain('caseAccuracy');
    expect(gate.checks.find((c) => c.name === 'caseAccuracy')?.message).toMatch(/95% interval/);
  });

  it('passes a score that clears the floor with room to spare', () => {
    expect(failed(evaluateGate(input(cases(100, 0))))).not.toContain('caseAccuracy');
  });

  it('does not soften zero tolerance: one forbidden answer in many still fails', () => {
    const results = [
      ...cases(200, 0),
      result({ id: 'leak', forbiddenChecked: 1, forbiddenHits: ['secret'] }),
    ];

    expect(failed(evaluateGate(input(results)))).toContain('forbiddenRate');
  });

  it('judges the average when no interval is asked for, as before', () => {
    const plain = thresholdsSchema.parse({ ...thresholds, confidence: undefined });
    const results = cases(17, 3);

    expect(failed(evaluateGate({ ...input(results), thresholds: plain }))).not.toContain(
      'caseAccuracy',
    );
  });

  it('counts how many different questions there are, not how often each was asked', () => {
    const results = cases(3, 0, 5); // 3 questions, 15 results

    const gate = evaluateGate({ ...input(results), uniqueCases: 3 });
    expect(gate.checks.find((c) => c.name === 'cases')?.passed).toBe(false);
  });
});
