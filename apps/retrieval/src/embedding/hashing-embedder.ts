import { tokenize } from '../text/tokenizer';
import type { Embedder } from './embedder';

/** FNV-1a, 32-bit: small, fast and stable across runs and machines. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const WORD_WEIGHT = 1;
const TRIGRAM_WEIGHT = 0.5;

/**
 * Deterministic stand-in for a real embedding model, using feature hashing.
 *
 * Each word and each character trigram of a word is hashed into one of `dimensions` slots (with a
 * sign, so collisions tend to cancel rather than pile up), and the vector is normalised. Texts that
 * share words or word fragments therefore get similar vectors: "refund", "refunds" and "refunding"
 * are close even though they are different keywords.
 *
 * Limitation, stated plainly: this captures spelling overlap, not meaning. "reimbursement" will not
 * match "refund". A real embedding model fixes that, and the `Embedder` interface is the seam where
 * it plugs in; everything downstream (fusion, reranking, access control) is unchanged.
 */
export class HashingEmbedder implements Embedder {
  constructor(readonly dimensions: number = 256) {}

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedOne(text)));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const add = (feature: string, weight: number): void => {
      const hash = fnv1a(feature);
      const sign = (hash >>> 16) & 1 ? 1 : -1;
      vector[hash % this.dimensions] = (vector[hash % this.dimensions] as number) + sign * weight;
    };

    for (const token of tokenize(text)) {
      add(`w:${token}`, WORD_WEIGHT);
      if (token.length >= 3) {
        const padded = `#${token}#`;
        for (let i = 0; i <= padded.length - 3; i++)
          add(`t:${padded.slice(i, i + 3)}`, TRIGRAM_WEIGHT);
      }
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
  }
}
