export interface RerankCandidate {
  id: string;
  text: string;
  /** Markdown heading path the chunk sits under, if any. */
  headingPath?: string[];
}

export interface Reranked {
  id: string;
  score: number;
}

/**
 * Second-pass scoring of a small candidate set. First-stage retrieval is cheap and recall-oriented
 * (scan everything, keep the top ~50); a reranker is slower and precision-oriented (read each
 * candidate against the query). In production this is a cross-encoder or Azure AI Search's
 * semantic ranker; locally it is the overlap heuristic.
 */
export interface Reranker {
  rerank(query: string, candidates: readonly RerankCandidate[]): Promise<Reranked[]>;
}

export const RERANKER = Symbol('RERANKER');
