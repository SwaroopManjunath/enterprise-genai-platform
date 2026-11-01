import { loadCorpus, loadDataset, checkDataset } from './dataset';
import { loadBaseline, loadThresholds } from './gate';
import { LexicalJudge } from './judge';
import { loadMetaExamples } from './judge-meta';
import type { EvalReport } from './report';
import { runEvaluation } from './runner';
import { VARIANTS, variantNames } from './variants';

const dataset = loadDataset();
const corpus = loadCorpus();
const thresholds = loadThresholds();
const baseline = loadBaseline();

const run = (variant: string, withBaseline = true): Promise<EvalReport> =>
  runEvaluation({
    dataset,
    corpus,
    variant: VARIANTS[variant] as (typeof VARIANTS)[string],
    judge: new LexicalJudge(),
    judgeExamples: loadMetaExamples(),
    thresholds,
    baseline: withBaseline ? baseline : undefined,
  });
const failedChecks = (r: EvalReport): string[] => [
  ...new Set(r.gate.checks.filter((c) => !c.passed).map((c) => c.name)),
];

describe('the evaluation, run against the real services', () => {
  it('starts from a sound dataset and a committed baseline', () => {
    expect(checkDataset(dataset, corpus)).toEqual([]);
    expect(baseline).toBeDefined();
  });

  describe('the system as it is', () => {
    let report: EvalReport;
    beforeAll(async () => {
      report = await run('good');
    });

    it('passes the gate, with every gated case fully correct', () => {
      expect(failedChecks(report)).toEqual([]);
      expect(report.gate.passed).toBe(true);
      expect(report.gated.passed).toBe(report.gated.cases);
    });

    it('has a baseline that is up to date: improve the system, then record the new baseline', () => {
      for (const [name, recorded] of Object.entries(baseline?.metrics ?? {})) {
        const now = report.gated.metrics[name as keyof typeof report.gated.metrics] as number;
        const tolerance = name === 'avgTokens' ? recorded * 0.01 : 0.001;
        expect({ name, drift: Math.abs(now - recorded) <= tolerance }).toEqual({
          name,
          drift: true,
        });
      }
      expect(report.gated.cases).toBe(baseline?.cases);
    });

    it('keeps multi-source questions and known gaps visible but out of the gate', () => {
      expect(Object.keys(report.informational.categories).sort()).toEqual([
        'known-gaps',
        'multi-source',
      ]);
      expect(report.informational.categories['multi-source']?.passed).toBe(0); // a stand-in limit, on record
      expect(report.informational.categories['known-gaps']?.passed).toBe(0); // a real gap, on record
      expect(report.results.filter((r) => !r.gated).every((r) => r.failures.length > 0)).toBe(true);
    });

    it('measures every part of the path', () => {
      expect(Object.keys(report.gated.metrics).sort()).toEqual(
        Object.keys(thresholds.metrics).sort(),
      );
      expect(Object.keys(report.categories)).toEqual(
        expect.arrayContaining([
          'faq',
          'paraphrase',
          'restricted-allowed',
          'restricted-denied',
          'no-answer',
          'injection',
          'pii',
          'tenant',
        ]),
      );
    });

    it('never lets a restricted fact, an injected payload or a card number into an answer', () => {
      for (const r of report.results.filter((x) => x.gated)) {
        expect({ id: r.id, hits: r.forbiddenHits }).toEqual({ id: r.id, hits: [] });
        expect({ id: r.id, leaked: r.retrieval.leaked }).toEqual({ id: r.id, leaked: [] });
      }
    });
  });

  describe('a gate is only worth having if it has been seen to fail', () => {
    const degraded = variantNames.filter((n) => VARIANTS[n]?.expectGate === 'fail');

    it.each(degraded)('catches the "%s" regression, and names the metric', async (name) => {
      const variant = VARIANTS[name] as (typeof VARIANTS)[string];

      const report = await run(name);

      expect(report.gate.passed).toBe(false);
      for (const metric of variant.expectedFailures) expect(failedChecks(report)).toContain(metric);
    });

    it('catches a single slipped answer with the ratchet, although every floor still holds', async () => {
      const report = await run('slips-once');

      const floors = report.gate.checks.filter((c) => c.kind === 'threshold' || c.kind === 'judge');
      const ratchet = report.gate.checks.filter((c) => c.kind === 'regression' && !c.passed);
      expect(floors.filter((c) => !c.passed)).toEqual([]);
      expect(ratchet.map((c) => c.name)).toEqual(['caseAccuracy']);
      expect(report.gate.passed).toBe(false);
      expect(
        report.results.filter((r) => r.gated && r.failures.length > 0).map((r) => r.id),
      ).toEqual(['record-retention']);
    });

    it('catches a regression with no baseline at all, from the absolute thresholds', async () => {
      const report = await run('hallucinating', false);

      expect(report.gate.passed).toBe(false);
      expect(report.gate.checks.some((c) => c.kind === 'regression')).toBe(false);
      expect(failedChecks(report)).toContain('groundedness');
    });

    it('explains a failure in words that point at the cases', async () => {
      const report = await run('hallucinating');

      const bad = report.results.filter((r) => r.gated && r.failures.length > 0);
      expect(bad.length).toBeGreaterThan(20);
      expect(bad[0]?.failures[0]).toMatch(/unsupported claim ".*Premium customers/);
    });
  });
});
