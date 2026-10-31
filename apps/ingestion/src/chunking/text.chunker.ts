import type { Chunk, ChunkOptions } from './types';
import { applyOverlap, packParts, splitParagraphs } from './text-utils';

/** Plain prose: paragraphs packed up to maxChars, with overlap between neighbours. */
export function chunkText(text: string, options: ChunkOptions): Chunk[] {
  const packed = packParts(splitParagraphs(text), options.maxChars);
  return applyOverlap(packed, options.overlapChars).map((chunk, index) => ({
    index,
    text: chunk,
    metadata: {},
  }));
}
