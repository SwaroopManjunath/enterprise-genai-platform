import { cosineSimilarity, type Embedder } from '../embedding/embedder';
import type { Caller, ChunkFilter, SearchIndex, SearchableChunk } from '../index/search-index';
import { bm25Rank } from '../ranking/bm25';
import { reciprocalRankFusion } from '../ranking/rrf';
import type { Reranker } from '../rerank/reranker';
import { tokenize } from '../text/tokenizer';

export type SearchMode = 'hybrid' | 'keyword' | 'vector';

export interface SearchRequest {
  query: string;
  topK: number;
  mode: SearchMode;
  rerank: boolean;
  filter?: ChunkFilter;
}

/** Why a chunk ranked where it did; invaluable when tuning relevance or explaining a result. */
export interface SearchSignals {
  keywordRank?: number;
  keywordScore?: number;
  vectorRank?: number;
  vectorScore?: number;
  fusedScore?: number;
  rerankScore?: number;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  text: string;
  metadata: Record<string, unknown>;
  /** The score that decided the final order (rerank if reranked, otherwise fused or single-mode). */
  score: number;
  signals: SearchSignals;
}

export interface SearchOptions {
  candidatesPerRetriever: number;
  rerankCandidates: number;
  rrfK: number;
  minSimilarity: number;
}

/**
 * Hybrid retrieval pipeline:
 *
 *   security-trimmed candidates -> keyword (BM25) + vector (cosine) retrieval -> rank fusion (RRF)
 *   -> rerank the top few -> top K
 *
 * Why both retrievers: keyword search nails exact terms (codes, names, "IBAN") but misses
 * wording and word-form differences; vector search tolerates those but can blur exact terms.
 * Each catches what the other misses, and fusing ranks keeps the strengths of both.
 */
export class SearchService {
  constructor(
    private readonly index: SearchIndex,
    private readonly embedder: Embedder,
    private readonly reranker: Reranker,
    private readonly options: SearchOptions,
  ) {}

  async search(caller: Caller, request: SearchRequest): Promise<SearchHit[]> {
    const candidates = await this.index.candidates(caller, request.filter);
    if (candidates.length === 0) return [];

    const byId = new Map(candidates.map((c) => [c.chunkId, c]));
    const signals = new Map<string, SearchSignals>();
    const signalsOf = (id: string): SearchSignals => {
      const existing = signals.get(id) ?? {};
      signals.set(id, existing);
      return existing;
    };

    const keywordIds =
      request.mode === 'vector' ? [] : this.keywordRetrieve(request.query, candidates, signalsOf);
    const vectorIds =
      request.mode === 'keyword'
        ? []
        : await this.vectorRetrieve(request.query, candidates, signalsOf);

    let ordered: string[];
    let baseScore: (id: string) => number;
    if (request.mode === 'hybrid') {
      const fused = reciprocalRankFusion([keywordIds, vectorIds], this.options.rrfK);
      fused.forEach((f) => (signalsOf(f.id).fusedScore = f.score));
      ordered = fused.map((f) => f.id);
      baseScore = (id) => signalsOf(id).fusedScore ?? 0;
    } else {
      ordered = request.mode === 'keyword' ? keywordIds : vectorIds;
      baseScore = (id) =>
        (request.mode === 'keyword' ? signalsOf(id).keywordScore : signalsOf(id).vectorScore) ?? 0;
    }

    const scores = new Map<string, number>(ordered.map((id) => [id, baseScore(id)]));
    if (request.rerank && ordered.length > 0) {
      ordered = await this.rerank(request.query, ordered, byId, signalsOf, scores);
    }

    return ordered.slice(0, request.topK).map((id) => {
      const chunk = byId.get(id) as SearchableChunk;
      return {
        chunkId: id,
        documentId: chunk.documentId,
        text: chunk.text,
        metadata: chunk.metadata,
        score: scores.get(id) ?? 0,
        signals: signalsOf(id),
      };
    });
  }

  private keywordRetrieve(
    query: string,
    candidates: readonly SearchableChunk[],
    signalsOf: (id: string) => SearchSignals,
  ): string[] {
    const ranked = bm25Rank(
      tokenize(query),
      candidates.map((c) => ({ id: c.chunkId, termFreqs: c.termFreqs, length: c.length })),
    ).slice(0, this.options.candidatesPerRetriever);

    ranked.forEach((r, i) => {
      const s = signalsOf(r.id);
      s.keywordRank = i + 1;
      s.keywordScore = r.score;
    });
    return ranked.map((r) => r.id);
  }

  private async vectorRetrieve(
    query: string,
    candidates: readonly SearchableChunk[],
    signalsOf: (id: string) => SearchSignals,
  ): Promise<string[]> {
    const [queryVector] = await this.embedder.embed([query]);
    if (!queryVector) return [];

    const ranked = candidates
      .map((c) => ({ id: c.chunkId, score: cosineSimilarity(queryVector, c.vector) }))
      .filter((r) => r.score >= this.options.minSimilarity)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, this.options.candidatesPerRetriever);

    ranked.forEach((r, i) => {
      const s = signalsOf(r.id);
      s.vectorRank = i + 1;
      s.vectorScore = r.score;
    });
    return ranked.map((r) => r.id);
  }

  /** Reranks only the top of the list (reranking is the costly step); the tail keeps its order. */
  private async rerank(
    query: string,
    ordered: string[],
    byId: ReadonlyMap<string, SearchableChunk>,
    signalsOf: (id: string) => SearchSignals,
    scores: Map<string, number>,
  ): Promise<string[]> {
    const pool = ordered.slice(0, this.options.rerankCandidates);
    const tail = ordered.slice(this.options.rerankCandidates);

    const reranked = await this.reranker.rerank(
      query,
      pool.map((id) => {
        const chunk = byId.get(id) as SearchableChunk;
        const heading = chunk.metadata['headingPath'];
        return {
          id,
          text: chunk.text,
          ...(Array.isArray(heading) && { headingPath: heading.map(String) }),
        };
      }),
    );

    reranked.forEach((r) => {
      signalsOf(r.id).rerankScore = r.score;
      scores.set(r.id, r.score);
    });
    return [...reranked.map((r) => r.id), ...tail];
  }
}
