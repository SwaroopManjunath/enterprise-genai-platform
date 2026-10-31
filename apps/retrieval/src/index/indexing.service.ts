import type { Embedder } from '../embedding/embedder';
import { termFrequencies, tokenize } from '../text/tokenizer';
import type { DocumentInfo, SearchIndex, SearchableChunk } from './search-index';

export interface IndexChunkInput {
  index: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertDocumentInput {
  chunks: IndexChunkInput[];
  /** Roles allowed to read this document; omit or leave empty for the whole tenant. */
  allowedRoles?: string[];
  tags?: string[];
  /** Hash of the source content, kept so the writer can detect unchanged re-uploads. */
  contentHash?: string;
}

export function chunkIdOf(documentId: string, index: number): string {
  return `${documentId}:${index}`;
}

const normalizeList = (values: readonly string[] = []): string[] => [
  ...new Set(values.map((v) => v.trim().toLowerCase()).filter((v) => v !== '')),
];

/** Prepares chunks for search (tokens for BM25, a vector for similarity) and stores them. */
export class IndexingService {
  constructor(
    private readonly index: SearchIndex,
    private readonly embedder: Embedder,
  ) {}

  /** Replaces the whole document, so re-sending an edited document leaves no stale chunks. */
  async upsertDocument(
    tenantId: string,
    documentId: string,
    input: UpsertDocumentInput,
  ): Promise<{ documentId: string; chunkCount: number }> {
    const vectors = await this.embedder.embed(input.chunks.map((c) => c.text));

    const chunks: SearchableChunk[] = input.chunks.map((chunk, i) => {
      const tokens = tokenize(chunk.text);
      return {
        chunkId: chunkIdOf(documentId, chunk.index),
        documentId,
        index: chunk.index,
        text: chunk.text,
        metadata: chunk.metadata ?? {},
        vector: vectors[i] as number[],
        termFreqs: termFrequencies(tokens),
        length: tokens.length,
      };
    });

    await this.index.replaceDocument(
      tenantId,
      documentId,
      chunks,
      { allowedRoles: normalizeList(input.allowedRoles), tags: normalizeList(input.tags) },
      input.contentHash,
    );
    return { documentId, chunkCount: chunks.length };
  }

  getDocument(tenantId: string, documentId: string): Promise<DocumentInfo | undefined> {
    return this.index.getDocument(tenantId, documentId);
  }

  deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    return this.index.deleteDocument(tenantId, documentId);
  }
}
