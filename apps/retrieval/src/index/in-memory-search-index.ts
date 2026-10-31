import {
  isVisible,
  type Caller,
  type ChunkFilter,
  type DocumentAcl,
  type DocumentInfo,
  type SearchIndex,
  type SearchableChunk,
} from './search-index';

interface StoredDocument {
  acl: DocumentAcl;
  chunks: readonly SearchableChunk[];
  contentHash: string | undefined;
  indexedAt: string;
}

/** Keyed by tenant then document, so a tenant's data is unreachable from another tenant's calls. */
export class InMemorySearchIndex implements SearchIndex {
  private readonly byTenant = new Map<string, Map<string, StoredDocument>>();

  replaceDocument(
    tenantId: string,
    documentId: string,
    chunks: readonly SearchableChunk[],
    acl: DocumentAcl,
    contentHash?: string,
  ): Promise<void> {
    const tenant = this.byTenant.get(tenantId) ?? new Map<string, StoredDocument>();
    // One assignment swaps the whole document: readers see all-old or all-new, never a mix, and
    // chunks from an older, longer version disappear.
    tenant.set(documentId, {
      acl: structuredClone(acl),
      chunks: structuredClone(chunks),
      contentHash,
      indexedAt: new Date().toISOString(),
    });
    this.byTenant.set(tenantId, tenant);
    return Promise.resolve();
  }

  getDocument(tenantId: string, documentId: string): Promise<DocumentInfo | undefined> {
    const stored = this.byTenant.get(tenantId)?.get(documentId);
    if (!stored) return Promise.resolve(undefined);
    return Promise.resolve({
      documentId,
      ...(stored.contentHash !== undefined && { contentHash: stored.contentHash }),
      chunkCount: stored.chunks.length,
      indexedAt: stored.indexedAt,
    });
  }

  deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    return Promise.resolve(this.byTenant.get(tenantId)?.delete(documentId) ?? false);
  }

  candidates(caller: Caller, filter: ChunkFilter = {}): Promise<readonly SearchableChunk[]> {
    const documents = this.byTenant.get(caller.tenantId);
    if (!documents) return Promise.resolve([]);

    const result: SearchableChunk[] = [];
    for (const [documentId, document] of documents) {
      if (!isVisible(document.acl, caller.roles)) continue;
      if (filter.documentIds && !filter.documentIds.includes(documentId)) continue;
      if (filter.tags && !filter.tags.some((tag) => document.acl.tags.includes(tag))) continue;
      result.push(...document.chunks);
    }
    return Promise.resolve(result);
  }
}
