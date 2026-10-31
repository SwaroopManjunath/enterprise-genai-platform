import { PermanentIngestionError } from '../domain/errors';
import type { IngestionJob } from '../domain/job';
import type { IngestionPipeline } from '../pipeline/ingestion-pipeline';
import { LockLostError, type MessageQueue, type QueueMessage } from '../queue/message-queue';
import type { JobStore } from '../store/job-store';

export interface WorkerOptions {
  maxDeliveries: number;
  retry: { baseDelayMs: number; maxDelayMs: number };
  /** Injectable for tests; must return a number in [0, 1). */
  random?: () => number;
}

export type WorkResult = 'idle' | 'processed';

/**
 * Takes one message at a time and decides its fate:
 *
 *  - success                 -> complete (removed from the queue)
 *  - permanent error         -> dead-letter now; retrying a bad document cannot help
 *  - transient error         -> abandon with exponential backoff and jitter, so a struggling
 *                               dependency gets breathing room
 *  - transient, out of tries -> dead-letter with the last error, for a human to inspect
 *
 * Several workers can run side by side (competing consumers): the queue's lock ensures each
 * message is handled by one of them at a time.
 */
export class IngestionWorker {
  private readonly random: () => number;

  constructor(
    private readonly queue: MessageQueue<IngestionJob>,
    private readonly pipeline: IngestionPipeline,
    private readonly jobs: JobStore,
    private readonly options: WorkerOptions,
  ) {
    this.random = options.random ?? Math.random;
  }

  async processOnce(): Promise<WorkResult> {
    const message = await this.queue.receive();
    if (!message) return 'idle';

    const { jobId } = message.body;
    await this.jobs.update(jobId, { status: 'processing', attempts: message.deliveryCount });

    try {
      const result = await this.pipeline.run(message.body);
      await this.queue.complete(message);
      await this.jobs.update(jobId, {
        status: result.outcome === 'indexed' ? 'succeeded' : 'unchanged',
        chunkCount: result.chunkCount,
      });
    } catch (error) {
      // If our lock expired another worker owns the message now. The pipeline is idempotent, so
      // whatever we wrote is harmless; do not touch the message or the job record.
      if (error instanceof LockLostError) return 'processed';
      await this.handleFailure(message, error).catch((e: unknown) => {
        if (!(e instanceof LockLostError)) throw e;
      });
    }
    return 'processed';
  }

  /** Processes until the queue has nothing visible; returns how many messages were handled. */
  async drain(limit = 1000): Promise<number> {
    let handled = 0;
    while (handled < limit && (await this.processOnce()) === 'processed') handled++;
    return handled;
  }

  private async handleFailure(message: QueueMessage<IngestionJob>, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const { jobId } = message.body;

    if (error instanceof PermanentIngestionError) {
      await this.queue.deadLetter(message, reason);
      await this.jobs.update(jobId, { status: 'failed', error: reason });
      return;
    }

    if (message.deliveryCount >= this.options.maxDeliveries) {
      await this.queue.deadLetter(message, `Retries exhausted: ${reason}`);
      await this.jobs.update(jobId, { status: 'failed', error: reason });
      return;
    }

    await this.queue.abandon(message, this.backoffMs(message.deliveryCount));
    await this.jobs.update(jobId, { status: 'queued', error: reason });
  }

  /** Exponential backoff with full jitter, capped. */
  private backoffMs(deliveryCount: number): number {
    const { baseDelayMs, maxDelayMs } = this.options.retry;
    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (deliveryCount - 1));
    return Math.floor(this.random() * cap);
  }
}
