/** A chunk with everything search needs precomputed at indexing time. Treat as read-only. */
export interface SearchableChunk {
  /** Deterministic `${documentId}:${index}`, so re-indexing overwrites rather than duplicates. */
  chunkId: string;
  documentId: string;
  index: number;
  text: string;
  metadata: Record<string, unknown>;
  vector: readonly number[];
  termFreqs: ReadonlyMap<string, number>;
  /** Token count, used by BM25 length normalisation. */
  length: number;
}

/** Who may see a document. An empty `allowedRoles` means any member of the tenant. */
export interface DocumentAcl {
  allowedRoles: readonly string[];
  tags: readonly string[];
}

export interface DocumentInfo {
  documentId: string;
  contentHash?: string;
  chunkCount: number;
  indexedAt: string;
}

export interface Caller {
  tenantId: string;
  roles: readonly string[];
}

export interface ChunkFilter {
  documentIds?: readonly string[];
  /** Matches documents carrying at least one of these tags. */
  tags?: readonly string[];
}

/** The access rule, in one place: open documents are visible to the tenant; otherwise a role must match. */
export function isVisible(acl: DocumentAcl, roles: readonly string[]): boolean {
  return acl.allowedRoles.length === 0 || acl.allowedRoles.some((role) => roles.includes(role));
}

/**
 * Storage and candidate selection (Azure AI Search in production).
 *
 * `candidates` is **security-trimmed by contract**: it returns only chunks of the caller's own
 * tenant that the caller's roles may see, then applies the optional filter. Trimming happens here,
 * before any scoring, so no later stage (BM25 statistics, vector search, reranking, result
 * ordering) can ever be influenced by, or leak, a document the caller is not allowed to read. In
 * Azure AI Search this is a pre-filter (`$filter`) applied to the query, not a post-filter.
 */
export interface SearchIndex {
  /**
   * Replaces the document as a unit. `contentHash` is remembered so the service that wrote it
   * (ingestion) can ask later whether a re-upload is unchanged and skip the work.
   */
  replaceDocument(
    tenantId: string,
    documentId: string,
    chunks: readonly SearchableChunk[],
    acl: DocumentAcl,
    contentHash?: string,
  ): Promise<void>;
  /** Bookkeeping about an indexed document. Not access-trimmed: for the indexing service only. */
  getDocument(tenantId: string, documentId: string): Promise<DocumentInfo | undefined>;
  deleteDocument(tenantId: string, documentId: string): Promise<boolean>;
  candidates(caller: Caller, filter?: ChunkFilter): Promise<readonly SearchableChunk[]>;
}

export const SEARCH_INDEX = Symbol('SEARCH_INDEX');
