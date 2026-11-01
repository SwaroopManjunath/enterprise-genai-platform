import type { CaseResult } from './evaluate';
import { mean, percentile } from './metrics';

/**
 * The numbers a build is judged on. `higher` metrics must not fall, `lower` ones must not rise.
 */
export const METRICS = {
  caseAccuracy: 'higher',
  retrievalRecallAtK: 'higher',
  retrievalMRR: 'higher',
  retrievalLeaks: 'lower',
  answerRate: 'higher',
  abstentionAccuracy: 'higher',
  blockAccuracy: 'higher',
  factRecall: 'higher',
  groundedness: 'higher',
  citationPrecision: 'higher',
  citationRecall: 'higher',
  forbiddenRate: 'lower',
  avgTokens: 'lower',
} as const;

export type MetricKey = keyof typeof METRICS;

export interface Aggregates {
  cases: number;
  passed: number;
  metrics: Partial<Record<MetricKey, number>>;
  /** Informational only: not gated, because it is noisy by nature. */
  p95Ms?: number;
}

export interface CategorySummary {
  cases: number;
  passed: number;
}

const share = (hit: number, of: number): number | undefined => (of === 0 ? undefined : hit / of);

/** Aggregates over a set of case results. A metric with no applicable cases is left out, not zero. */
export function aggregate(results: readonly CaseResult[]): Aggregates {
  const answerable = results.filter((r) => r.answerable && !r.expectBlocked);
  const unanswerable = results.filter((r) => !r.answerable && !r.expectBlocked);
  const attacks = results.filter((r) => r.expectBlocked);
  const answered = answerable.filter((r) => r.status === 'answered');
  const withForbidden = results.filter((r) => r.forbiddenChecked > 0);

  const metrics: Aggregates['metrics'] = {};
  const set = (key: MetricKey, value: number | undefined) => {
    if (value !== undefined) metrics[key] = value;
  };

  set('caseAccuracy', share(results.filter((r) => r.failures.length === 0).length, results.length));
  set(
    'retrievalRecallAtK',
    mean(results.flatMap((r) => (r.retrieval.recall === undefined ? [] : [r.retrieval.recall]))),
  );
  set(
    'retrievalMRR',
    mean(results.flatMap((r) => (r.retrieval.mrr === undefined ? [] : [r.retrieval.mrr]))),
  );
  set(
    'retrievalLeaks',
    results.length === 0 ? undefined : results.filter((r) => r.retrieval.leaked.length > 0).length,
  );
  set('answerRate', share(answered.length, answerable.length));
  set(
    'abstentionAccuracy',
    share(unanswerable.filter((r) => r.status === 'abstained').length, unanswerable.length),
  );
  set('blockAccuracy', share(attacks.filter((r) => r.status === 'blocked').length, attacks.length));
  set(
    'factRecall',
    mean(answerable.map((r) => (r.facts && r.facts.total > 0 ? r.facts.found / r.facts.total : 0))),
  );
  set(
    'groundedness',
    mean(results.flatMap((r) => (r.groundedness === undefined ? [] : [r.groundedness]))),
  );
  set(
    'citationPrecision',
    mean(
      answered.flatMap((r) =>
        r.citations?.precision === undefined ? [] : [r.citations.precision],
      ),
    ),
  );
  set(
    'citationRecall',
    mean(answered.flatMap((r) => (r.citations === undefined ? [] : [r.citations.recall]))),
  );
  set(
    'forbiddenRate',
    withForbidden.length === 0
      ? undefined
      : withForbidden.filter((r) => r.forbiddenHits.length > 0).length / withForbidden.length,
  );
  set('avgTokens', mean(results.flatMap((r) => (r.tokens === undefined ? [] : [r.tokens]))));

  const p95Ms = percentile(
    results.flatMap((r) => (r.totalMs === undefined ? [] : [r.totalMs])),
    95,
  );
  return {
    cases: results.length,
    passed: results.filter((r) => r.failures.length === 0).length,
    metrics,
    ...(p95Ms !== undefined && { p95Ms }),
  };
}

export function byCategory(results: readonly CaseResult[]): Record<string, CategorySummary> {
  const out: Record<string, CategorySummary> = {};
  for (const r of results) {
    const entry = out[r.category] ?? { cases: 0, passed: 0 };
    entry.cases += 1;
    if (r.failures.length === 0) entry.passed += 1;
    out[r.category] = entry;
  }
  return out;
}
