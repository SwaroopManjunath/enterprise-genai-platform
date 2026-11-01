import { aggregate, byCategory } from './aggregate';
import type { EvalCase } from './dataset';
import { evaluateCase, type CaseResult, type Observation } from './evaluate';
import { evaluateGate, thresholdsSchema, type Baseline, type Thresholds } from './gate';
import type { Judgement } from './judge';
import { renderConsole, renderMarkdown, type EvalReport } from './report';

const faq: EvalCase = {
  id: 'refund-time',
  category: 'faq',
  caller: 'analyst',
  question: 'How long do refunds take?',
  answerable: true,
  expectedDocuments: ['handbook'],
  facts: ['five working days'],
  forbidden: [],
  mustNotRetrieve: [],
  expectBlocked: false,
};
const denied: EvalCase = {
  ...faq,
  id: 'salary-analyst',
  category: 'restricted-denied',
  answerable: false,
  expectedDocuments: [],
  facts: [],
  forbidden: ['level M1'],
  mustNotRetrieve: ['salary-bands'],
};
const attack: EvalCase = {
  ...denied,
  id: 'attack',
  category: 'injection',
  forbidden: ['PWNED'],
  mustNotRetrieve: [],
  expectBlocked: true,
};

const seen = (overrides: Partial<Observation> = {}): Observation => ({
  httpStatus: 200,
  blocked: false,
  answer: 'Refunds take five working days. [1]',
  retrieved: [
    { documentId: 'handbook', chunkId: 'handbook:0', text: 'Refunds take five working days.' },
  ],
  cited: [{ documentId: 'handbook', chunkId: 'handbook:0' }],
  tokens: 200,
  totalMs: 10,
  ...overrides,
});
const grounded: Judgement = {
  score: 1,
  claims: [{ claim: 'Refunds take five working days.', supported: true }],
};

describe('evaluateCase', () => {
  it('passes a right, cited, grounded answer', () => {
    const r = evaluateCase(faq, seen(), grounded, true);

    expect(r).toMatchObject({
      status: 'answered',
      failures: [],
      groundedness: 1,
      citations: { precision: 1, recall: 1 },
    });
    expect(r.retrieval).toEqual({ recall: 1, mrr: 1, leaked: [] });
    expect(r.facts).toEqual({ found: 1, total: 1 });
  });

  it('says in words what is wrong with a bad answer', () => {
    const r = evaluateCase(
      faq,
      seen({
        answer: 'It takes a while. [2]',
        cited: [{ documentId: 'other', chunkId: 'other:0' }],
      }),
      {
        score: 0,
        claims: [
          {
            claim: 'It takes a while.',
            supported: false,
            reason: 'only 20% of its words appear in the sources',
          },
        ],
      },
      true,
    );

    expect(r.failures).toEqual([
      'the answer lacks the fact "five working days"',
      'cited a document outside the expected set',
      'cited none of the expected documents',
      'unsupported claim "It takes a while." (only 20% of its words appear in the sources)',
    ]);
  });

  it('fails an answerable question that was declined', () => {
    const r = evaluateCase(
      faq,
      seen({
        answer: 'I could not find anything about that in the documents available to you.',
        cited: [],
      }),
      undefined,
      true,
    );

    expect(r.status).toBe('abstained');
    expect(r.failures).toContain('declined to answer a question that has an answer');
    expect(r.facts).toEqual({ found: 0, total: 1 });
  });

  it('passes a question correctly declined, and fails one that was answered or leaked', () => {
    const declined = seen({
      answer: 'I could not find anything about that.',
      retrieved: [],
      cited: [],
    });

    expect(evaluateCase(denied, declined, undefined, true).failures).toEqual([]);
    const answered = evaluateCase(
      denied,
      seen({ answer: 'Bands start at level M1.' }),
      undefined,
      true,
    );
    expect(answered.failures).toEqual([
      'answered a question it should have declined',
      'the answer contains forbidden text "level M1"',
    ]);
    const leaked = evaluateCase(
      denied,
      seen({
        answer: 'I could not find anything.',
        retrieved: [{ documentId: 'salary-bands', chunkId: 's:0', text: 'x' }],
      }),
      undefined,
      true,
    );
    expect(leaked.failures).toEqual([
      'retrieval returned "salary-bands", which this caller must never see',
    ]);
  });

  it('expects an attack to be refused outright, and a legitimate question not to be', () => {
    expect(
      evaluateCase(
        attack,
        seen({ blocked: true, httpStatus: 422, answer: undefined, retrieved: [], cited: [] }),
        undefined,
        true,
      ).failures,
    ).toEqual([]);
    expect(evaluateCase(attack, seen({ answer: 'PWNED' }), undefined, true).failures).toEqual([
      'an attack was not refused outright',
      'answered a question it should have declined',
      'the answer contains forbidden text "PWNED"',
    ]);
    expect(
      evaluateCase(
        faq,
        seen({ blocked: true, httpStatus: 422, answer: undefined }),
        undefined,
        true,
      ).failures,
    ).toContain('a legitimate question was refused');
  });

  it('reports a failed request as such', () => {
    expect(
      evaluateCase(faq, seen({ httpStatus: 503, answer: undefined }), undefined, true).failures,
    ).toContain('the request failed with status 503');
  });
});

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

describe('aggregate', () => {
  it('computes each metric over the cases it applies to', () => {
    const results = [
      result({ id: 'a' }),
      result({
        id: 'b',
        retrieval: { recall: 0.5, mrr: 0.5, leaked: [] },
        facts: { found: 0, total: 2 },
        groundedness: 0.5,
        tokens: 400,
        failures: ['x'],
      }),
      result({
        id: 'c',
        category: 'restricted-denied',
        answerable: false,
        status: 'abstained',
        facts: undefined,
        citations: undefined,
        groundedness: undefined,
        retrieval: { leaked: [] },
        forbiddenChecked: 1,
      }),
      result({
        id: 'd',
        category: 'restricted-denied',
        answerable: false,
        status: 'answered',
        facts: undefined,
        citations: undefined,
        groundedness: undefined,
        retrieval: { leaked: ['salary'] },
        forbiddenChecked: 1,
        forbiddenHits: ['M1'],
        failures: ['y'],
      }),
      result({
        id: 'e',
        category: 'injection',
        answerable: false,
        expectBlocked: true,
        status: 'blocked',
        facts: undefined,
        citations: undefined,
        groundedness: undefined,
        retrieval: { leaked: [] },
      }),
    ];

    const { metrics, cases, passed } = aggregate(results);

    expect(cases).toBe(5);
    expect(passed).toBe(3);
    expect(metrics).toEqual({
      caseAccuracy: 0.6,
      retrievalRecallAtK: 0.75,
      retrievalMRR: 0.75,
      retrievalLeaks: 1,
      answerRate: 1,
      abstentionAccuracy: 0.5,
      blockAccuracy: 1,
      factRecall: 0.5, // (1 + 0) / 2
      groundedness: 0.75,
      citationPrecision: 1,
      citationRecall: 1,
      forbiddenRate: 0.5,
      avgTokens: 240,
    });
  });

  it('leaves out a metric that no case applies to, instead of calling it zero', () => {
    const { metrics } = aggregate([
      result({
        answerable: false,
        status: 'abstained',
        facts: undefined,
        citations: undefined,
        groundedness: undefined,
        retrieval: { leaked: [] },
      }),
    ]);

    expect(metrics.factRecall).toBeUndefined();
    expect(metrics.answerRate).toBeUndefined();
    expect(metrics.abstentionAccuracy).toBe(1);
  });

  it('counts a declined answerable question as zero fact recall, not as missing', () => {
    const { metrics } = aggregate([
      result({
        status: 'abstained',
        facts: { found: 0, total: 1 },
        citations: undefined,
        groundedness: undefined,
      }),
    ]);

    expect(metrics.factRecall).toBe(0);
    expect(metrics.answerRate).toBe(0);
  });

  it('summarises by category', () => {
    expect(
      byCategory([result({}), result({ failures: ['x'] }), result({ category: 'pii' })]),
    ).toEqual({
      faq: { cases: 2, passed: 1 },
      pii: { cases: 1, passed: 1 },
    });
  });
});

const thresholds: Thresholds = thresholdsSchema.parse({
  metrics: {
    caseAccuracy: { min: 0.9 },
    groundedness: { min: 0.95 },
    retrievalLeaks: { max: 0 },
    avgTokens: { max: 300 },
  },
  judgeAccuracy: { min: 0.9 },
  minCases: { total: 3, perCategory: 1 },
  informationalCategories: {},
  regression: { absolute: 0.02, relativeCost: 0.05 },
});
const good = {
  aggregates: {
    cases: 4,
    passed: 4,
    metrics: { caseAccuracy: 1, groundedness: 1, retrievalLeaks: 0, avgTokens: 200 },
  },
  categories: { faq: { cases: 4, passed: 4 } },
  judgeAccuracy: 1,
  thresholds,
  baseline: undefined,
};
const baseline: Baseline = {
  cases: 4,
  judgeAccuracy: 1,
  metrics: { caseAccuracy: 1, groundedness: 1, retrievalLeaks: 0, avgTokens: 200 },
};
const failedNames = (g: ReturnType<typeof evaluateGate>) =>
  g.checks.filter((c) => !c.passed).map((c) => c.name);

describe('evaluateGate', () => {
  it('passes a build inside every limit', () => {
    expect(evaluateGate(good).passed).toBe(true);
  });

  it('fails a metric below its floor or above its ceiling, and says which', () => {
    const g = evaluateGate({
      ...good,
      aggregates: {
        ...good.aggregates,
        metrics: { ...good.aggregates.metrics, groundedness: 0.9, avgTokens: 350 },
      },
    });

    expect(g.passed).toBe(false);
    expect(failedNames(g)).toEqual(['groundedness', 'avgTokens']);
    expect(g.checks.find((c) => c.name === 'groundedness')?.message).toBe(
      'groundedness is 0.900, must be at least 0.950',
    );
  });

  it('fails a metric that could not be computed: a missing number is never a pass', () => {
    const { groundedness: _g, ...rest } = good.aggregates.metrics;

    const g = evaluateGate({ ...good, aggregates: { ...good.aggregates, metrics: rest } });

    expect(failedNames(g)).toEqual(['groundedness']);
    expect(g.checks.find((c) => c.name === 'groundedness')?.message).toMatch(
      /could not be computed/,
    );
  });

  it('fails a judge that scores badly on its own test set', () => {
    expect(failedNames(evaluateGate({ ...good, judgeAccuracy: 0.8 }))).toEqual(['judgeAccuracy']);
  });

  it('fails a dataset too small to mean anything, in total or in a category', () => {
    expect(
      failedNames(evaluateGate({ ...good, aggregates: { ...good.aggregates, cases: 2 } })),
    ).toEqual(['cases']);
    expect(
      failedNames(
        evaluateGate({
          ...good,
          thresholds: { ...thresholds, minCases: { total: 3, perCategory: 5 } },
        }),
      ),
    ).toEqual(['cases:faq']);
  });

  describe('against a baseline (the ratchet)', () => {
    it('fails a metric that slipped more than the tolerance even though it is still above its floor', () => {
      const g = evaluateGate({
        ...good,
        baseline,
        aggregates: {
          ...good.aggregates,
          metrics: { ...good.aggregates.metrics, caseAccuracy: 0.93 },
        },
      });

      expect(
        g.checks.find((c) => c.name === 'caseAccuracy' && c.kind === 'threshold')?.passed,
      ).toBe(true);
      expect(failedNames(g)).toEqual(['caseAccuracy']);
      expect(g.checks.find((c) => c.kind === 'regression' && !c.passed)?.message).toMatch(
        /baseline 1 \(worse by 0.070, allowed 0.020\)/,
      );
    });

    it('allows a small wobble, and any improvement', () => {
      const g = evaluateGate({
        ...good,
        baseline,
        aggregates: {
          ...good.aggregates,
          metrics: { ...good.aggregates.metrics, caseAccuracy: 0.99 },
        },
      });

      expect(g.passed).toBe(true);
    });

    it('allows no new leak and no new forbidden text, whatever the tolerance', () => {
      const g = evaluateGate({
        ...good,
        thresholds: {
          ...thresholds,
          metrics: { ...thresholds.metrics, retrievalLeaks: { max: 5 } },
        },
        baseline,
        aggregates: {
          ...good.aggregates,
          metrics: { ...good.aggregates.metrics, retrievalLeaks: 1 },
        },
      });

      expect(failedNames(g)).toEqual(['retrievalLeaks']);
    });

    it('lets cost grow by a few percent, not more', () => {
      const run = (avgTokens: number) =>
        evaluateGate({
          ...good,
          thresholds: {
            ...thresholds,
            metrics: { ...thresholds.metrics, avgTokens: { max: 1000 } },
          },
          baseline,
          aggregates: { ...good.aggregates, metrics: { ...good.aggregates.metrics, avgTokens } },
        });

      expect(run(208).passed).toBe(true);
      expect(failedNames(run(230))).toEqual(['avgTokens']);
    });
  });
});

describe('reports', () => {
  const failing = evaluateGate({
    ...good,
    aggregates: { ...good.aggregates, metrics: { ...good.aggregates.metrics, groundedness: 0.5 } },
  });
  const report: EvalReport = {
    variant: 'hallucinating',
    dataset: 'support-qa',
    judge: { name: 'lexical', accuracy: 1, knownMisses: ['recombined'] },
    gate: failing,
    gated: good.aggregates,
    categories: good.categories,
    informational: {
      categories: {
        'multi-source': { cases: 3, passed: 0, reason: 'the stand-in answers from one source' },
      },
    },
    results: [
      result({ id: 'refund-time', failures: ['unsupported claim "x"'] }),
      result({
        id: 'multi',
        category: 'multi-source',
        gated: false,
        failures: ['the answer lacks the fact "y"'],
      }),
    ],
  };

  it('names the verdict, why it failed, the failing cases and what is not gated', () => {
    const md = renderMarkdown(report);

    expect(md).toContain('## Evaluation: FAILED');
    expect(md).toContain('**groundedness**: groundedness is 0.500, must be at least 0.950');
    expect(md).toContain('`refund-time` (faq): unsupported claim "x"');
    expect(md).toContain('`multi` (multi-source, not gated)');
    expect(md).toContain('the stand-in answers from one source');
    expect(md).toContain('Known to get wrong: recombined');
  });

  it('says passed when it passed, and has no failure section', () => {
    const md = renderMarkdown({ ...report, gate: evaluateGate(good), results: [] });

    expect(md).toContain('## Evaluation: PASSED');
    expect(md).not.toContain('Why it failed');
  });

  it('gives a terminal summary ending in the verdict', () => {
    const text = renderConsole(report);

    expect(text).toContain('FAIL  groundedness is 0.500');
    expect(text.trim().endsWith('GATE: FAILED')).toBe(true);
    expect(text).not.toContain('multi:'); // not gated, so not in the terminal's list of what went wrong
  });
});
