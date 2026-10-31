/**
 * Turns text into vectors so "similar" texts end up close together. In production this is an Azure
 * OpenAI embedding deployment (called through the LLM gateway); locally it is the hashing stand-in.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export const EMBEDDER = Symbol('EMBEDDER');

/** Cosine similarity in [-1, 1]; 0 when either vector is all zeros. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}
