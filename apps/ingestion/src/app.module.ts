import { TelemetryModule } from '@genai/observability';
import {
  EntraClientCredentialsClient,
  EnvSecretProvider,
  SECRET_PROVIDER,
  authProviders,
  type SecretProvider,
} from '@genai/auth';
import { HttpJsonClient } from '@genai/shared';
import { Logger, Module } from '@nestjs/common';
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
import { RetrievalChunkIndex } from './store/retrieval-chunk-index';
import { InMemoryJobStore, JOB_STORE, type JobStore } from './store/job-store';
import { IngestionWorker } from './worker/ingestion-worker';
import { WorkerLoop } from './worker/worker-loop';

@Module({
  imports: [TelemetryModule.forService('ingestion')],
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
    // Env-backed locally. In Azure, wire KeyVaultSecretProvider with a managed identity here.
    { provide: SECRET_PROVIDER, useFactory: () => new EnvSecretProvider() },
    {
      provide: CHUNK_INDEX,
      inject: [INGESTION_CONFIG, SECRET_PROVIDER],
      useFactory: (c: IngestionConfig, secrets: SecretProvider): ChunkIndex => {
        if (c.index.sink === 'memory') {
          new Logger('ChunkIndex').warn(
            'INDEX_SINK=memory: processed documents stay inside this process and are NOT ' +
              'searchable. Set INDEX_SINK=retrieval to make uploads answerable.',
          );
          return new InMemoryChunkIndex();
        }
        return new RetrievalChunkIndex(
          new HttpJsonClient({
            service: 'retrieval',
            baseUrl: c.index.url,
            timeoutMs: c.index.timeoutMs,
          }),
          new EntraClientCredentialsClient({
            tokenEndpoint: c.index.tokenEndpoint,
            clientId: c.index.clientId,
            clientSecretName: c.index.clientSecretName,
            secrets,
          }),
          c.index.scope,
        );
      },
    },
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
