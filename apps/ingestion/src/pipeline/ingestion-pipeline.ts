import { chunkDocument, detectFileType, type ChunkOptions } from '../chunking';
import type { IngestionJob } from '../domain/job';
import { chunkId, type ChunkIndex } from '../store/chunk-index';

export interface PipelineResult {
  outcome: 'indexed' | 'unchanged';
  chunkCount: number;
}

/**
 * The work done for one document: detect type, chunk, write to the index.
 *
 * Idempotent in two ways:
 *  1. A document whose content hash matches what is already indexed is skipped entirely, so a
 *     redelivered message or a repeated upload costs nothing.
 *  2. Otherwise chunks are written with deterministic ids and the document is replaced as a unit,
 *     so a retry after a partial failure, or a re-ingest of an edited document, never leaves
 *     duplicate or stale chunks behind.
 */
export class IngestionPipeline {
  constructor(
    private readonly index: ChunkIndex,
    private readonly chunking: ChunkOptions,
  ) {}

  async run(job: IngestionJob): Promise<PipelineResult> {
    const existing = await this.index.getDocument(job.tenantId, job.documentId);
    if (existing?.contentHash === job.contentHash) {
      return { outcome: 'unchanged', chunkCount: existing.chunkCount };
    }

    const fileType = detectFileType(job.filename, job.contentType);
    const chunks = chunkDocument(fileType, job.content, this.chunking, job.filename);

    await this.index.replaceDocument(
      job.tenantId,
      job.documentId,
      job.contentHash,
      chunks.map((c) => ({
        id: chunkId(job.documentId, c.index),
        index: c.index,
        text: c.text,
        metadata: c.metadata,
      })),
    );
    return { outcome: 'indexed', chunkCount: chunks.length };
  }
}
