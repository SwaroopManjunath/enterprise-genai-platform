import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3003),
  /** Size of the local stand-in embedding; a real embedding model fixes its own size. */
  VECTOR_DIMENSIONS: z.coerce.number().int().min(16).max(4096).default(256),
  /** Candidates each retriever (keyword, vector) contributes before fusion. */
  CANDIDATES_PER_RETRIEVER: z.coerce.number().int().min(1).max(500).default(50),
  /** How many fused candidates are passed to the (more expensive) reranker. */
  RERANK_CANDIDATES: z.coerce.number().int().min(1).max(200).default(20),
  /** Reciprocal Rank Fusion constant; 60 is the value from the original paper. */
  RRF_K: z.coerce.number().int().min(1).default(60),
  /** Vector matches below this cosine similarity are noise and are dropped. */
  MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.1),
});

export interface RetrievalConfig {
  port: number;
  vectorDimensions: number;
  candidatesPerRetriever: number;
  rerankCandidates: number;
  rrfK: number;
  minSimilarity: number;
}

export const RETRIEVAL_CONFIG = Symbol('RETRIEVAL_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RetrievalConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    vectorDimensions: e.VECTOR_DIMENSIONS,
    candidatesPerRetriever: e.CANDIDATES_PER_RETRIEVER,
    rerankCandidates: e.RERANK_CANDIDATES,
    rrfK: e.RRF_K,
    minSimilarity: e.MIN_SIMILARITY,
  };
}
