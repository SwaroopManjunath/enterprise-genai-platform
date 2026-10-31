import { tokenize } from '../text/tokenizer';
import type { RerankCandidate, Reranked, Reranker } from './reranker';

const HEADING_WEIGHT = 0.5;
const ORDER_WEIGHT = 0.5;

/**
 * Local reranker that rewards candidates which actually answer the whole query:
 *
 *  - coverage: fraction of the query's distinct terms present in the chunk (a chunk matching 4 of
 *    4 terms beats one matching 1 term many times, which is what raw BM25 can favour);
 *  - heading match: a bonus when query terms appear in the section heading;
 *  - word order: a bonus for query word pairs that appear adjacent and in order ("refund period").
 *
 * Score range is 0 to 2. It is a heuristic stand-in for a cross-encoder, not a learned model.
 */
export class OverlapReranker implements Reranker {
  rerank(query: string, candidates: readonly RerankCandidate[]): Promise<Reranked[]> {
    const terms = [...new Set(tokenize(query))];
    const queryOrder = tokenize(query);
    const queryBigrams = bigrams(queryOrder);

    const scored = candidates.map((candidate) => {
      if (terms.length === 0) return { id: candidate.id, score: 0 };

      const textTokens = tokenize(candidate.text);
      const textSet = new Set(textTokens);
      const headingSet = new Set(tokenize((candidate.headingPath ?? []).join(' ')));

      const coverage = terms.filter((t) => textSet.has(t)).length / terms.length;
      const headingCoverage = terms.filter((t) => headingSet.has(t)).length / terms.length;

      const textBigrams = new Set(bigrams(textTokens));
      const orderScore =
        queryBigrams.length === 0
          ? 0
          : queryBigrams.filter((b) => textBigrams.has(b)).length / queryBigrams.length;

      return {
        id: candidate.id,
        score: coverage + HEADING_WEIGHT * headingCoverage + ORDER_WEIGHT * orderScore,
      };
    });

    return Promise.resolve(scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)));
  }
}

function bigrams(tokens: readonly string[]): string[] {
  return tokens.slice(1).map((token, i) => `${tokens[i]} ${token}`);
}
