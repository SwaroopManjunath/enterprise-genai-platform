import { randomUUID } from 'node:crypto';
import {
  DeadLetterNotFoundError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  JobNotFoundError,
} from '../domain/errors';
import { hashDocument, normalizeAcl, type IngestionJob, type JobRecord } from '../domain/job';
import type { MessageQueue } from '../queue/message-queue';
import type { ChunkIndex, IndexedDocument } from '../store/chunk-index';
import type { JobStore } from '../store/job-store';

export interface SubmitInput {
  documentId: string;
  filename: string;
  contentType?: string;
  content: string;
  /** Roles allowed to read the document once searchable; omit for the whole tenant. */
  allowedRoles?: string[];
  tags?: string[];
}

export interface DeadLetterView {
  jobId: string;
  documentId: string;
  filename: string;
  reason: string;
  deliveryCount: number;
  deadLetteredAt: string;
}

/** What the HTTP layer talks to: accept work, report on it, and manage failed work. */
export class IngestionService {
  constructor(
    private readonly queue: MessageQueue<IngestionJob>,
    private readonly jobs: JobStore,
    private readonly index: ChunkIndex,
    private readonly maxDocumentBytes: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Accepts a document for processing and returns immediately; the worker does the rest. */
  async submit(tenantId: string, input: SubmitInput): Promise<JobRecord> {
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > this.maxDocumentBytes)
      throw new DocumentTooLargeError(bytes, this.maxDocumentBytes);

    const at = this.now().toISOString();
    const acl = normalizeAcl(input);
    const job: IngestionJob = {
      jobId: randomUUID(),
      tenantId,
      documentId: input.documentId,
      filename: input.filename,
      content: input.content,
      acl,
      contentHash: hashDocument(input.content, acl),
      ...(input.contentType !== undefined && { contentType: input.contentType }),
    };
    const record: JobRecord = {
      jobId: job.jobId,
      tenantId,
      documentId: job.documentId,
      status: 'queued',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };

    // Record first, then enqueue: a worker can only ever see a job that has a status record.
    await this.jobs.create(record);
    await this.queue.enqueue(job);
    return record;
  }

  async getJob(tenantId: string, jobId: string): Promise<JobRecord> {
    const record = await this.jobs.get(tenantId, jobId);
    if (!record) throw new JobNotFoundError(jobId);
    return record;
  }

  async getDocument(tenantId: string, documentId: string): Promise<IndexedDocument> {
    const document = await this.index.getDocument(tenantId, documentId);
    if (!document) throw new DocumentNotFoundError(documentId);
    return document;
  }

  async listDeadLetters(tenantId: string): Promise<DeadLetterView[]> {
    const letters = await this.queue.deadLetters();
    return letters
      .filter((l) => l.body.tenantId === tenantId)
      .map((l) => ({
        jobId: l.body.jobId,
        documentId: l.body.documentId,
        filename: l.body.filename,
        reason: l.reason,
        deliveryCount: l.deliveryCount,
        deadLetteredAt: l.deadLetteredAt,
      }));
  }

  /** Sends a dead-lettered job back for another go (for example after fixing the dependency). */
  async requeueDeadLetter(tenantId: string, jobId: string): Promise<JobRecord> {
    const letter = (await this.queue.deadLetters()).find(
      (l) => l.body.jobId === jobId && l.body.tenantId === tenantId,
    );
    if (!letter || !(await this.queue.requeueDeadLetter(letter.id))) {
      throw new DeadLetterNotFoundError(jobId);
    }
    await this.jobs.update(jobId, { status: 'queued', attempts: 0 });
    return this.getJob(tenantId, jobId);
  }
}
