import type { AppTokenClient } from '@genai/auth';
import { DownstreamError, type HttpJsonClient } from '@genai/shared';
import { PermanentIngestionError } from '../domain/errors';
import type { DocumentAcl } from '../domain/job';
import type { ChunkIndex, IndexedChunk, IndexedDocument } from './chunk-index';

interface RemoteDocumentInfo {
  documentId: string;
  contentHash?: string;
  chunkCount: number;
  indexedAt: string;
}

/**
 * Writes chunks to the retrieval service's search index, so an uploaded document becomes
 * answerable.
 *
 * The pipeline runs in the background with no user, so it authenticates as itself (a
 * client-credentials token holding the `indexer` role) and names the tenant the document belongs
 * to. That tenant was fixed from the uploader's verified token when the document was submitted, so
 * the pipeline never has to trust anything it merely read from the queue about who the user was.
 *
 * Error handling feeds the worker's retry policy: a document the index rejects as invalid can
 * never succeed (permanent, dead-lettered at once); everything else (index down, slow, throttled,
 * our credentials refused) may succeed later, so it is thrown as a transient error to be retried
 * with backoff and, if it keeps failing, parked in the dead-letter queue with the reason.
 */
export class RetrievalChunkIndex implements ChunkIndex {
  constructor(
    private readonly http: HttpJsonClient,
    private readonly tokens: AppTokenClient,
    private readonly scope: string,
  ) {}

  async getDocument(tenantId: string, documentId: string): Promise<IndexedDocument | undefined> {
    const token = await this.tokens.getToken(this.scope);
    try {
      const info = await this.http.get<RemoteDocumentInfo>(
        documentPath(tenantId, documentId),
        token,
      );
      // Without a hash we cannot prove it is unchanged, so treat it as not yet indexed.
      if (!info.contentHash) return undefined;
      return {
        documentId: info.documentId,
        contentHash: info.contentHash,
        chunkCount: info.chunkCount,
        indexedAt: info.indexedAt,
      };
    } catch (error) {
      if (error instanceof DownstreamError && error.kind === 'http' && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async replaceDocument(
    tenantId: string,
    documentId: string,
    contentHash: string,
    chunks: IndexedChunk[],
    acl: DocumentAcl,
  ): Promise<void> {
    const token = await this.tokens.getToken(this.scope);
    try {
      await this.http.put(documentPath(tenantId, documentId), token, {
        chunks: chunks.map(({ index, text, metadata }) => ({ index, text, metadata })),
        allowedRoles: acl.allowedRoles,
        tags: acl.tags,
        contentHash,
      });
    } catch (error) {
      if (
        error instanceof DownstreamError &&
        error.kind === 'http' &&
        (error.status === 400 || error.status === 413)
      ) {
        throw new PermanentIngestionError(
          `The search index rejected this document (${error.code ?? error.status})`,
        );
      }
      throw error;
    }
  }
}

const documentPath = (tenantId: string, documentId: string): string =>
  `/v1/tenants/${encodeURIComponent(tenantId)}/index/documents/${encodeURIComponent(documentId)}`;
