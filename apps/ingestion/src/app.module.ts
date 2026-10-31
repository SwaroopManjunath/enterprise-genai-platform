import { authProviders } from '@genai/auth';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { INGESTION_CONFIG, loadConfig, type IngestionConfig } from './config/config';
import type { IngestionJob } from './domain/job';
import { HealthController } from './health.controller';
import { IngestionController } from './ingestion/ingestion.controller';
import { IngestionExceptionFilter } from './ingestion/ingestion-exception.filter';
import { IngestionService } from './ingestion/ingestion.service';
import { IngestionPipeline } from './pipeline/ingestion-pipeline';
import { InMemoryQueue } from './queue/in-memory-queue';
import { MESSAGE_QUEUE, type MessageQueue } from './queue/message-queue';
import { CHUNK_INDEX, type ChunkIndex } from './store/chunk-index';
import { InMemoryChunkIndex } from './store/in-memory-chunk-index';
import { InMemoryJobStore, JOB_STORE, type JobStore } from './store/job-store';
import { IngestionWorker } from './worker/ingestion-worker';
import { WorkerLoop } from './worker/worker-loop';

@Module({
  controllers: [HealthController, IngestionController],
  providers: [
    { provide: INGESTION_CONFIG, useFactory: () => loadConfig() },
    {
      provide: MESSAGE_QUEUE,
      inject: [INGESTION_CONFIG],
      useFactory: (c: IngestionConfig) =>
        new InMemoryQueue<IngestionJob>({
          maxDeliveries: c.maxDeliveries,
          visibilityTimeoutMs: c.visibilityTimeoutMs,
        }),
    },
    { provide: CHUNK_INDEX, useFactory: () => new InMemoryChunkIndex() },
    { provide: JOB_STORE, useFactory: () => new InMemoryJobStore() },
    {
      provide: IngestionPipeline,
      inject: [CHUNK_INDEX, INGESTION_CONFIG],
      useFactory: (index: ChunkIndex, c: IngestionConfig) =>
        new IngestionPipeline(index, c.chunking),
    },
    {
      provide: IngestionWorker,
      inject: [MESSAGE_QUEUE, IngestionPipeline, JOB_STORE, INGESTION_CONFIG],
      useFactory: (
        queue: MessageQueue<IngestionJob>,
        pipeline: IngestionPipeline,
        jobs: JobStore,
        c: IngestionConfig,
      ) =>
        new IngestionWorker(queue, pipeline, jobs, {
          maxDeliveries: c.maxDeliveries,
          retry: c.retry,
        }),
    },
    {
      provide: IngestionService,
      inject: [MESSAGE_QUEUE, JOB_STORE, CHUNK_INDEX, INGESTION_CONFIG],
      useFactory: (
        queue: MessageQueue<IngestionJob>,
        jobs: JobStore,
        index: ChunkIndex,
        c: IngestionConfig,
      ) => new IngestionService(queue, jobs, index, c.maxDocumentBytes),
    },
    {
      provide: WorkerLoop,
      inject: [IngestionWorker, INGESTION_CONFIG],
      useFactory: (worker: IngestionWorker, c: IngestionConfig) =>
        new WorkerLoop(worker, c.pollIntervalMs),
    },
    { provide: APP_FILTER, useClass: IngestionExceptionFilter },
    ...authProviders(),
  ],
})
export class AppModule {}
