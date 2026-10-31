import type { ChunkIndex, IndexedChunk, IndexedDocument } from './chunk-index';

interface Stored {
  document: IndexedDocument;
  chunks: IndexedChunk[];
}

/** Keyed by tenant then document, so tenants can never see or overwrite each other's chunks. */
export class InMemoryChunkIndex implements ChunkIndex {
  private readonly byTenant = new Map<string, Map<string, Stored>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  getDocument(tenantId: string, documentId: string): Promise<IndexedDocument | undefined> {
    const stored = this.byTenant.get(tenantId)?.get(documentId);
    return Promise.resolve(stored && { ...stored.document });
  }

  replaceDocument(
    tenantId: string,
    documentId: string,
    contentHash: string,
    chunks: IndexedChunk[],
  ): Promise<void> {
    const tenant = this.byTenant.get(tenantId) ?? new Map<string, Stored>();
    // One assignment swaps the whole document, so readers never see a half-old, half-new mix.
    tenant.set(documentId, {
      document: {
        documentId,
        contentHash,
        chunkCount: chunks.length,
        indexedAt: this.now().toISOString(),
      },
      chunks: structuredClone(chunks),
    });
    this.byTenant.set(tenantId, tenant);
    return Promise.resolve();
  }

  getChunks(tenantId: string, documentId: string): Promise<IndexedChunk[]> {
    const stored = this.byTenant.get(tenantId)?.get(documentId);
    return Promise.resolve(structuredClone(stored?.chunks ?? []));
  }
}
