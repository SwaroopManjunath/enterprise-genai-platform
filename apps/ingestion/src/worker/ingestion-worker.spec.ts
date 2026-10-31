import { hashContent, type IngestionJob } from '../domain/job';
import { IngestionPipeline } from '../pipeline/ingestion-pipeline';
import { InMemoryQueue } from '../queue/in-memory-queue';
import { InMemoryChunkIndex } from '../store/in-memory-chunk-index';
import { InMemoryJobStore } from '../store/job-store';
import { IngestionWorker } from './ingestion-worker';

const VISIBILITY_MS = 1000;
const MAX_DELIVERIES = 3;

function setup(pipelineOverride?: (real: IngestionPipeline) => Pick<IngestionPipeline, 'run'>) {
  const clock = { now: 0 };
  const queue = new InMemoryQueue<IngestionJob>({
    maxDeliveries: MAX_DELIVERIES,
    visibilityTimeoutMs: VISIBILITY_MS,
    now: () => clock.now,
  });
  const index = new InMemoryChunkIndex();
  const jobs = new InMemoryJobStore();
  const real = new IngestionPipeline(index, { maxChars: 100, overlapChars: 0 });
  const pipeline = (pipelineOverride?.(real) ?? real) as IngestionPipeline;
  const worker = new IngestionWorker(queue, pipeline, jobs, {
    maxDeliveries: MAX_DELIVERIES,
    retry: { baseDelayMs: 100, maxDelayMs: 10_000 },
    random: () => 1 - Number.EPSILON, // jitter at the cap: deterministic worst-case delay
  });

  async function submit(content: string, filename = 'doc.md', documentId = 'doc'): Promise<string> {
    const job: IngestionJob = {
      jobId: `job-${Math.random().toString(36).slice(2)}`,
      tenantId: 'acme',
      documentId,
      filename,
      content,
      contentHash: hashContent(content),
    };
    const now = new Date().toISOString();
    await jobs.create({
      jobId: job.jobId,
      tenantId: 'acme',
      documentId,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    await queue.enqueue(job);
    return job.jobId;
  }

  return { clock, queue, index, jobs, worker, submit };
}

describe('IngestionWorker', () => {
  it('reports idle on an empty queue', async () => {
    expect(await setup().worker.processOnce()).toBe('idle');
  });

  it('processes a document end to end', async () => {
    const { worker, submit, jobs, index } = setup();
    const jobId = await submit('# Title\nSome body text.');

    expect(await worker.processOnce()).toBe('processed');

    expect(await jobs.get('acme', jobId)).toMatchObject({ status: 'succeeded', chunkCount: 1 });
    expect(await index.getChunks('acme', 'doc')).toHaveLength(1);
  });

  it('marks a redelivered duplicate as unchanged instead of re-indexing', async () => {
    const { worker, submit, jobs } = setup();
    await submit('# T\nbody.');
    const second = await submit('# T\nbody.');

    await worker.drain();

    expect((await jobs.get('acme', second))?.status).toBe('unchanged');
  });

  it('dead-letters a permanently bad document immediately, without retries', async () => {
    const { worker, submit, jobs, queue } = setup();
    const jobId = await submit('binary', 'scan.pdf');

    await worker.drain();

    const record = await jobs.get('acme', jobId);
    expect(record).toMatchObject({ status: 'failed', attempts: 1 });
    expect(record?.error).toMatch(/Unsupported file type/);
    expect((await queue.deadLetters())[0]).toMatchObject({ deliveryCount: 1 });
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    let calls = 0;
    const { worker, submit, jobs, clock } = setup((real) => ({
      run: (job) => {
        calls += 1;
        if (calls <= 2) return Promise.reject(new Error('search unavailable'));
        return real.run(job);
      },
    }));
    const jobId = await submit('# T\nbody.');

    await worker.processOnce(); // attempt 1 fails
    expect(await jobs.get('acme', jobId)).toMatchObject({
      status: 'queued',
      error: 'search unavailable',
    });
    expect(await worker.processOnce()).toBe('idle'); // still backing off (100ms)

    clock.now += 100;
    await worker.processOnce(); // attempt 2 fails, backs off 200ms
    expect(await worker.processOnce()).toBe('idle');

    clock.now += 200;
    await worker.processOnce(); // attempt 3 succeeds

    expect(await jobs.get('acme', jobId)).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('dead-letters after retries are exhausted, keeping the last error', async () => {
    const { worker, submit, jobs, queue, clock } = setup(() => ({
      run: () => Promise.reject(new Error('search unavailable')),
    }));
    const jobId = await submit('# T\nbody.');

    for (let i = 0; i < MAX_DELIVERIES; i++) {
      await worker.processOnce();
      clock.now += 10_000;
    }

    expect(await jobs.get('acme', jobId)).toMatchObject({
      status: 'failed',
      attempts: MAX_DELIVERIES,
      error: 'search unavailable',
    });
    expect((await queue.deadLetters())[0]?.reason).toBe('Retries exhausted: search unavailable');
    expect(await worker.processOnce()).toBe('idle');
  });

  it('does not fail when its lock was taken over mid-processing', async () => {
    const harness = setup();
    const { queue, clock } = harness;
    // Rebuild a worker whose pipeline stalls past the lock timeout and lets someone else grab it.
    const slow = new IngestionWorker(
      queue,
      {
        run: async () => {
          clock.now += VISIBILITY_MS + 1;
          await queue.receive(); // another consumer takes over
          return { outcome: 'indexed', chunkCount: 1 };
        },
      } as unknown as IngestionPipeline,
      harness.jobs,
      { maxDeliveries: MAX_DELIVERIES, retry: { baseDelayMs: 1, maxDelayMs: 1 } },
    );
    const jobId = await harness.submit('# T\nbody.');

    await expect(slow.processOnce()).resolves.toBe('processed');

    // The new owner still holds the message; our stale attempt did not mark the job done.
    expect((await harness.jobs.get('acme', jobId))?.status).toBe('processing');
  });
});
