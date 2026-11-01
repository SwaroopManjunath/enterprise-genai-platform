import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { METRICS, type Aggregates, type CategorySummary, type MetricKey } from './aggregate';
import type { Interval } from './stats';
import { DATASETS_DIR } from './dataset';

const metricKeys = Object.keys(METRICS) as [MetricKey, ...MetricKey[]];
const limit = z.object({ min: z.number().optional(), max: z.number().optional() });

export const thresholdsSchema = z.object({
  /** Absolute limits: a build outside them fails however it compares with the last one. */
  metrics: z.record(z.enum(metricKeys), limit),
  /** How well the judge itself must score on the labelled judge set. */
  judgeAccuracy: z.object({ min: z.number() }),
  /** Too few cases cannot show anything, so the dataset itself is held to a size. */
  minCases: z.object({ total: z.number().int(), perCategory: z.number().int() }),
  /** Reported but not gated, with the reason it is not gated. */
  informationalCategories: z.record(z.string(), z.string()),
  /**
   * For a model that does not answer the same way twice: judge each metric by the edge of its
   * confidence interval that is nearer the limit, instead of by its average.
   */
  confidence: z.object({ level: z.number().gt(0.5).lt(1) }).optional(),
  /** The ratchet: how far a metric may move the wrong way from the baseline. */
  regression: z.object({ absolute: z.number(), relativeCost: z.number() }),
});

export type Thresholds = z.infer<typeof thresholdsSchema>;

export const baselineSchema = z.object({
  cases: z.number(),
  judgeAccuracy: z.number(),
  metrics: z.record(z.enum(metricKeys), z.number()),
});

export type Baseline = z.infer<typeof baselineSchema>;

export const loadThresholds = (file = join(DATASETS_DIR, '..', 'thresholds.json')): Thresholds =>
  thresholdsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

export function loadBaseline(
  file = join(DATASETS_DIR, '..', 'baseline.json'),
): Baseline | undefined {
  try {
    return baselineSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

export interface Check {
  kind: 'threshold' | 'regression' | 'sample' | 'judge';
  name: string;
  passed: boolean;
  value?: number;
  limit?: string;
  message: string;
}

export interface GateResult {
  passed: boolean;
  checks: Check[];
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3));

/**
 * Decides whether a build may ship. Four kinds of check, so quality cannot slip through any one:
 *  - thresholds: an absolute floor (or ceiling) on every metric;
 *  - regression: no metric may move the wrong way from the committed baseline by more than a small
 *    tolerance, even while it is still above its threshold (a ratchet: quality only goes up);
 *  - sample size: enough cases overall and per category for the numbers to mean something;
 *  - the judge: groundedness is only trustworthy if the judge scores well on its own labelled set.
 * A metric that could not be computed fails its check. A missing number is never a pass.
 */
export function evaluateGate(input: {
  aggregates: Aggregates;
  categories: Record<string, CategorySummary>;
  judgeAccuracy: number;
  thresholds: Thresholds;
  baseline: Baseline | undefined;
  /** Present when the evaluation was run several times: see `thresholds.confidence`. */
  intervals?: Partial<Record<MetricKey, Interval>>;
  /** Cases the dataset has, which differs from `aggregates.cases` when each was run several times. */
  uniqueCases?: number;
}): GateResult {
  const { aggregates, categories, judgeAccuracy, thresholds, baseline, intervals } = input;
  const checks: Check[] = [];

  for (const [name, bound] of Object.entries(thresholds.metrics) as [
    MetricKey,
    { min?: number; max?: number },
  ][]) {
    const value = aggregates.metrics[name];
    const text = [
      bound.min !== undefined && `at least ${fmt(bound.min)}`,
      bound.max !== undefined && `at most ${fmt(bound.max)}`,
    ]
      .filter(Boolean)
      .join(' and ');
    if (value === undefined) {
      checks.push({
        kind: 'threshold',
        name,
        passed: false,
        limit: text,
        message: `${name} could not be computed: no case applies`,
      });
      continue;
    }
    // Zero tolerance (a leak, a forbidden phrase) is never softened by an interval: one is too many.
    const interval = thresholds.confidence && intervals ? intervals[name] : undefined;
    const useInterval = interval !== undefined && !(bound.max === 0);
    const lowest = useInterval && interval ? interval.lower : value;
    const highest = useInterval && interval ? interval.upper : value;
    const passed =
      (bound.min === undefined || lowest >= bound.min) &&
      (bound.max === undefined || highest <= bound.max);
    const spread =
      useInterval && interval
        ? ` (${Math.round((thresholds.confidence?.level ?? 0.95) * 100)}% interval ${fmt(interval.lower)} to ${fmt(interval.upper)})`
        : '';
    checks.push({
      kind: 'threshold',
      name,
      passed,
      value,
      limit: text,
      message: `${name} is ${fmt(value)}${spread}, must be ${text}`,
    });
  }

  checks.push({
    kind: 'judge',
    name: 'judgeAccuracy',
    passed: judgeAccuracy >= thresholds.judgeAccuracy.min,
    value: judgeAccuracy,
    limit: `at least ${fmt(thresholds.judgeAccuracy.min)}`,
    message: `the judge agrees with the labels on ${fmt(judgeAccuracy)} of its test set, must be at least ${fmt(thresholds.judgeAccuracy.min)}`,
  });

  checks.push({
    kind: 'sample',
    name: 'cases',
    passed: (input.uniqueCases ?? aggregates.cases) >= thresholds.minCases.total,
    value: input.uniqueCases ?? aggregates.cases,
    limit: `at least ${thresholds.minCases.total}`,
    message: `${input.uniqueCases ?? aggregates.cases} gated cases, need at least ${thresholds.minCases.total}`,
  });
  for (const [category, summary] of Object.entries(categories)) {
    checks.push({
      kind: 'sample',
      name: `cases:${category}`,
      passed: summary.cases >= thresholds.minCases.perCategory,
      value: summary.cases,
      limit: `at least ${thresholds.minCases.perCategory}`,
      message: `${summary.cases} cases in ${category}, need at least ${thresholds.minCases.perCategory}`,
    });
  }

  if (baseline) {
    for (const name of Object.keys(METRICS) as MetricKey[]) {
      const before = baseline.metrics[name];
      const now = aggregates.metrics[name];
      if (before === undefined) continue;
      if (now === undefined) {
        checks.push({
          kind: 'regression',
          name,
          passed: false,
          message: `${name} was ${fmt(before)} in the baseline and cannot be computed now`,
        });
        continue;
      }
      const worse = METRICS[name] === 'higher' ? before - now : now - before;
      const allowed =
        name === 'avgTokens'
          ? before * thresholds.regression.relativeCost
          : thresholds.regression.absolute;
      const tolerance = name === 'retrievalLeaks' || name === 'forbiddenRate' ? 0 : allowed;
      checks.push({
        kind: 'regression',
        name,
        passed: worse <= tolerance,
        value: now,
        limit: `baseline ${fmt(before)}`,
        message: `${name} is ${fmt(now)}, baseline ${fmt(before)} (${worse > 0 ? 'worse by' : 'not worse, by'} ${fmt(Math.abs(worse))}, allowed ${fmt(tolerance)})`,
      });
    }
  }

  return { passed: checks.every((c) => c.passed), checks };
}
