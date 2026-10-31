export type FileType = 'markdown' | 'text' | 'csv';

export interface ChunkMetadata {
  /** Markdown: enclosing headings, outermost first. */
  headingPath?: string[];
  /** CSV: 1-based data-row range covered by this chunk (header excluded). */
  rowStart?: number;
  rowEnd?: number;
}

export interface Chunk {
  index: number;
  text: string;
  metadata: ChunkMetadata;
}

export interface ChunkOptions {
  /** Target size of a chunk's own content, in characters. */
  maxChars: number;
  /** Characters of the previous chunk repeated at the start of the next (prose only). */
  overlapChars: number;
}
