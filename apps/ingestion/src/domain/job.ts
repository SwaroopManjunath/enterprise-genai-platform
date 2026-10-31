import { createHash } from 'node:crypto';

/** Queue message body: everything the worker needs to process one document. */
export interface IngestionJob {
  jobId: string;
  tenantId: string;
  /** Caller-chosen stable id; re-submitting the same id means "this document changed". */
  documentId: string;
  filename: string;
  contentType?: string;
  content: string;
  /** sha256 of `content`; lets the worker skip documents that have not changed. */
  contentHash: string;
}

export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'unchanged' | 'failed';

export interface JobRecord {
  jobId: string;
  tenantId: string;
  documentId: string;
  status: JobStatus;
  /** Delivery attempts so far. */
  attempts: number;
  chunkCount?: number;
  /** Last error message; set on retries and on dead-lettering. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
