export interface FusedResult {
  id: string;
  score: number;
  /** 1-based rank in each input list, in input order; undefined where the list did not contain it. */
  ranks: (number | undefined)[];
}

/**
 * Reciprocal Rank Fusion: score(d) = sum over lists of 1 / (k + rank(d)).
 *
 * Keyword scores (BM25) and vector scores (cosine similarity) live on unrelated scales, so adding
 * or averaging them needs tuning that goes stale. Ranks are comparable across any retriever, so
 * RRF needs no normalisation and no weights: a document near the top of several lists wins, and a
 * document that only one retriever found still gets a fair score.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k = 60,
): FusedResult[] {
  const byId = new Map<string, FusedResult>();

  rankings.forEach((ranking, listIndex) => {
    ranking.forEach((id, position) => {
      const entry = byId.get(id) ?? { id, score: 0, ranks: rankings.map(() => undefined) };
      entry.score += 1 / (k + position + 1);
      entry.ranks[listIndex] = position + 1;
      byId.set(id, entry);
    });
  });

  return [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
