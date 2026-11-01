import { normalizeForMatch } from './text';

export interface RetrievalScore {
  /** Share of the expected documents found in the top k results. */
  recall: number;
  /** Reciprocal rank of the first expected document (0 when none was found). */
  mrr: number;
}

/** `ranked` is document ids best first; duplicates (several chunks of one document) count once. */
export function retrievalScore(
  ranked: readonly string[],
  expected: readonly string[],
  k: number,
): RetrievalScore {
  const unique = [...new Set(ranked)];
  const top = unique.slice(0, k);
  const found = expected.filter((d) => top.includes(d)).length;
  const firstRank = unique.findIndex((d) => expected.includes(d));
  return {
    recall: expected.length === 0 ? 1 : found / expected.length,
    mrr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
  };
}

/** Documents the caller must never be shown that did come back. */
export const leakedDocuments = (
  retrieved: readonly string[],
  forbidden: readonly string[],
): string[] => [...new Set(retrieved)].filter((d) => forbidden.includes(d));

export interface FactScore {
  found: number;
  total: number;
  missing: string[];
}

/**
 * Does the answer contain the facts it should? A fact is a phrase, or alternatives separated by `|`
 * ("five working days|5 working days"); matching ignores case, punctuation and thousands commas.
 */
export function factScore(answer: string, facts: readonly string[]): FactScore {
  const haystack = ` ${normalizeForMatch(answer)} `;
  const missing = facts.filter(
    (fact) => !fact.split('|').some((alt) => haystack.includes(` ${normalizeForMatch(alt)} `)),
  );
  return { found: facts.length - missing.length, total: facts.length, missing };
}

/** Strings that must NOT be in the answer: a restricted fact, an injected instruction's payload. */
export function forbiddenHits(answer: string, forbidden: readonly string[]): string[] {
  const haystack = ` ${normalizeForMatch(answer)} `;
  return forbidden.filter((f) => haystack.includes(` ${normalizeForMatch(f)} `));
}

const ABSTENTION =
  /could not find|couldnt find|do not know|dont know|cannot provide|cant provide|no information|not able to (?:find|answer)/i;

/** Did the assistant decline to answer (nothing found, not known, or blocked)? */
export const isAbstention = (answer: string): boolean =>
  ABSTENTION.test(answer.replace(/['’]/g, ''));

export interface CitationScore {
  /** Share of the cited documents that were right; absent when nothing was cited. */
  precision?: number;
  /** Share of the expected documents that were cited. */
  recall: number;
}

export function citationScore(
  cited: readonly string[],
  expected: readonly string[],
): CitationScore {
  const unique = [...new Set(cited)];
  const right = unique.filter((d) => expected.includes(d)).length;
  return {
    ...(unique.length > 0 && { precision: right / unique.length }),
    recall:
      expected.length === 0
        ? 1
        : expected.filter((d) => unique.includes(d)).length / expected.length,
  };
}

export const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;

export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
