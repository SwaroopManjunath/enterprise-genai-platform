export interface Bm25Document {
  id: string;
  termFreqs: ReadonlyMap<string, number>;
  /** Number of tokens in the document. */
  length: number;
}

export interface Scored {
  id: string;
  score: number;
}

export interface Bm25Options {
  /** Term-frequency saturation: higher means repeated terms keep adding score for longer. */
  k1?: number;
  /** Length normalisation: 0 ignores document length, 1 fully normalises by it. */
  b?: number;
}

/**
 * Okapi BM25 keyword ranking over the given documents.
 *
 * Statistics (document frequency, average length) are computed from exactly the documents passed
 * in. Callers pass only documents the user may see, so restricted content cannot influence the
 * scores of visible content (no leak through rare-term statistics).
 *
 * Returns only documents that match at least one query term, best first.
 */
export function bm25Rank(
  queryTokens: readonly string[],
  documents: readonly Bm25Document[],
  { k1 = 1.2, b = 0.75 }: Bm25Options = {},
): Scored[] {
  const terms = [...new Set(queryTokens)];
  if (terms.length === 0 || documents.length === 0) return [];

  const n = documents.length;
  const averageLength = documents.reduce((sum, d) => sum + d.length, 0) / n || 1;

  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = documents.reduce((count, d) => count + (d.termFreqs.has(term) ? 1 : 0), 0);
    // The "+1" inside the log keeps IDF positive even for terms present in most documents.
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const scored: Scored[] = [];
  for (const doc of documents) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.termFreqs.get(term);
      if (!tf) continue;
      const norm = 1 - b + b * (doc.length / averageLength);
      score += (idf.get(term) as number) * ((tf * (k1 + 1)) / (tf + k1 * norm));
    }
    if (score > 0) scored.push({ id: doc.id, score });
  }
  return scored.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}
