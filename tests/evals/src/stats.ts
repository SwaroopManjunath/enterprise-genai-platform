import { aggregate, METRICS, type MetricKey } from './aggregate';
import type { CaseResult } from './evaluate';

/** A small seeded generator, so the same results always give the same interval. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  lower: number;
  upper: number;
}

export interface IntervalOptions {
  /** How many resamples; 1000 is enough for a stable 95% interval on a few hundred results. */
  iterations?: number;
  level?: number;
  seed?: number;
}

const quantile = (sorted: readonly number[], q: number): number => {
  const position = q * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  const low = sorted[below] as number;
  const high = sorted[above] as number;
  return low + (high - low) * (position - below);
};

/**
 * A confidence interval for every metric, by resampling whole cases with replacement.
 *
 * A real model gives a different answer to the same question each time, so a case run three times
 * is three results that are not independent of each other: resampling the results one by one would
 * make the interval look narrower than it is. Resampling cases, each with all its runs, keeps that
 * dependence, so the interval says how much the score could move on a different set of questions.
 * A metric with nothing to measure in a resample is left out of that resample.
 */
export function metricIntervals(
  results: readonly CaseResult[],
  options: IntervalOptions = {},
): Partial<Record<MetricKey, Interval>> {
  const { iterations = 1000, level = 0.95, seed = 20260501 } = options;
  const byCase = new Map<string, CaseResult[]>();
  for (const r of results) byCase.set(r.id, [...(byCase.get(r.id) ?? []), r]);
  const ids = [...byCase.keys()];
  if (ids.length === 0) return {};

  const random = seededRandom(seed);
  const samples = Object.fromEntries(
    (Object.keys(METRICS) as MetricKey[]).map((k) => [k, [] as number[]]),
  ) as Record<MetricKey, number[]>;

  for (let i = 0; i < iterations; i++) {
    const pooled: CaseResult[] = [];
    for (let n = 0; n < ids.length; n++) {
      pooled.push(
        ...(byCase.get(ids[Math.floor(random() * ids.length)] as string) as CaseResult[]),
      );
    }
    const { metrics } = aggregate(pooled);
    for (const key of Object.keys(metrics) as MetricKey[])
      samples[key].push(metrics[key] as number);
  }

  const tail = (1 - level) / 2;
  const out: Partial<Record<MetricKey, Interval>> = {};
  for (const key of Object.keys(samples) as MetricKey[]) {
    const values = samples[key].sort((a, b) => a - b);
    if (values.length >= iterations / 2) {
      out[key] = { lower: quantile(values, tail), upper: quantile(values, 1 - tail) };
    }
  }
  return out;
}
