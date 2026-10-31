import { createHash } from 'node:crypto';

/** Who may read a document once it is searchable. Empty `allowedRoles` means the whole tenant. */
export interface DocumentAcl {
  allowedRoles: string[];
  tags: string[];
}

const normalizeList = (values: readonly string[] = []): string[] =>
  [...new Set(values.map((v) => v.trim().toLowerCase()).filter((v) => v !== ''))].sort();

export function normalizeAcl(input: {
  allowedRoles?: readonly string[];
  tags?: readonly string[];
}): DocumentAcl {
  return { allowedRoles: normalizeList(input.allowedRoles), tags: normalizeList(input.tags) };
}

/** Queue message body: everything the worker needs to process one document. */
export interface IngestionJob {
  jobId: string;
  tenantId: string;
  /** Caller-chosen stable id; re-submitting the same id means "this document changed". */
  documentId: string;
  filename: string;
  contentType?: string;
  content: string;
  /** Who may read it, carried from the upload all the way to the search index. */
  acl: DocumentAcl;
  /**
   * sha256 of the content AND the access list; lets the worker skip documents that have not
   * changed. The access list is part of it on purpose: re-uploading identical text with a tighter
   * list must not be skipped as "unchanged", or the old, looser access would silently stay.
   */
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

export function hashDocument(content: string, acl: DocumentAcl): string {
  return createHash('sha256')
    .update(JSON.stringify({ content, allowedRoles: acl.allowedRoles, tags: acl.tags }))
    .digest('hex');
}
