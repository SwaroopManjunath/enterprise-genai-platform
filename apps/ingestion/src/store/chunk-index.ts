import type { ChunkMetadata } from '../chunking/types';
import type { DocumentAcl } from '../domain/job';

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
 * Where chunks end up: the retrieval service's search index in production, an in-memory stand-in
 * for development and tests. The port deliberately has no way to read chunks back: only retrieval
 * serves content, and it does so after trimming by the caller's tenant and roles.
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
    acl: DocumentAcl,
  ): Promise<void>;
}

export const CHUNK_INDEX = Symbol('CHUNK_INDEX');
