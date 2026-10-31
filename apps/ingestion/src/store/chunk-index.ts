import type { ChunkMetadata } from '../chunking/types';

export interface IndexedChunk {
  /** Deterministic: `${documentId}:${index}`, so re-indexing overwrites instead of duplicating. */
  id: string;
  index: number;
  text: string;
  metadata: ChunkMetadata;
}

export interface IndexedDocument {
  documentId: string;
  contentHash: string;
  chunkCount: number;
  indexedAt: string;
}

export function chunkId(documentId: string, index: number): string {
  return `${documentId}:${index}`;
}

/**
 * Where chunks end up (Azure AI Search in production, with embeddings added in Step 5).
 *
 * `replaceDocument` is the idempotency primitive: it makes the stored chunks for a document equal
 * exactly the given set, removing any stale chunks left from an older, longer version. Calling it
 * twice with the same input leaves the same state.
 */
export interface ChunkIndex {
  getDocument(tenantId: string, documentId: string): Promise<IndexedDocument | undefined>;
  replaceDocument(
    tenantId: string,
    documentId: string,
    contentHash: string,
    chunks: IndexedChunk[],
  ): Promise<void>;
  getChunks(tenantId: string, documentId: string): Promise<IndexedChunk[]>;
}

export const CHUNK_INDEX = Symbol('CHUNK_INDEX');
