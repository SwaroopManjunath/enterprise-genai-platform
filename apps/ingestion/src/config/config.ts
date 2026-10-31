import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3002),
    /** 0 disables the background poller (tests drive the worker by hand). */
    POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(500),
    /** How long a received message stays hidden; if the worker dies it reappears after this. */
    VISIBILITY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /** Attempts before a message is parked in the dead-letter queue. */
    MAX_DELIVERIES: z.coerce.number().int().min(1).default(3),
    RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1_000),
    RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
    CHUNK_MAX_CHARS: z.coerce.number().int().min(100).default(1_000),
    CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).default(100),
    /** Queue messages are size-limited (Service Bus: 256 KB), so large files must go to blob storage. */
    MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(200_000),

    /**
     * Where processed chunks go. "retrieval" writes them to the search index so they become
     * answerable; "memory" keeps them inside this process, for development and tests, which means
     * uploaded documents are NOT searchable.
     */
    INDEX_SINK: z.enum(['memory', 'retrieval']).default('memory'),
    RETRIEVAL_URL: z.string().url().optional(),
    RETRIEVAL_SCOPE: z.string().min(1).default('api://retrieval/.default'),
    INDEX_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    /** This service's own identity (client credentials): token endpoint, client id, secret NAME. */
    TOKEN_ENDPOINT: z.string().url().optional(),
    CLIENT_ID: z.string().min(1).optional(),
    CLIENT_SECRET_NAME: z.string().min(1).default('ingestion-client-secret'),
  })
  .refine((e) => e.CHUNK_OVERLAP_CHARS < e.CHUNK_MAX_CHARS, {
    message: 'CHUNK_OVERLAP_CHARS must be smaller than CHUNK_MAX_CHARS',
  })
  .refine(
    (e) => e.INDEX_SINK !== 'retrieval' || (e.RETRIEVAL_URL && e.TOKEN_ENDPOINT && e.CLIENT_ID),
    {
      message: 'INDEX_SINK=retrieval requires RETRIEVAL_URL, TOKEN_ENDPOINT and CLIENT_ID',
    },
  );

export interface IngestionConfig {
  port: number;
  pollIntervalMs: number;
  visibilityTimeoutMs: number;
  maxDeliveries: number;
  retry: { baseDelayMs: number; maxDelayMs: number };
  chunking: { maxChars: number; overlapChars: number };
  maxDocumentBytes: number;
  index: IndexConfig;
}

export type IndexConfig =
  | { sink: 'memory' }
  | {
      sink: 'retrieval';
      url: string;
      scope: string;
      timeoutMs: number;
      tokenEndpoint: string;
      clientId: string;
      clientSecretName: string;
    };

export const INGESTION_CONFIG = Symbol('INGESTION_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestionConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    visibilityTimeoutMs: e.VISIBILITY_TIMEOUT_MS,
    maxDeliveries: e.MAX_DELIVERIES,
    retry: { baseDelayMs: e.RETRY_BASE_DELAY_MS, maxDelayMs: e.RETRY_MAX_DELAY_MS },
    chunking: { maxChars: e.CHUNK_MAX_CHARS, overlapChars: e.CHUNK_OVERLAP_CHARS },
    maxDocumentBytes: e.MAX_DOCUMENT_BYTES,
    index:
      e.INDEX_SINK === 'retrieval'
        ? {
            sink: 'retrieval',
            url: e.RETRIEVAL_URL as string,
            scope: e.RETRIEVAL_SCOPE,
            timeoutMs: e.INDEX_TIMEOUT_MS,
            tokenEndpoint: e.TOKEN_ENDPOINT as string,
            clientId: e.CLIENT_ID as string,
            clientSecretName: e.CLIENT_SECRET_NAME,
          }
        : { sink: 'memory' },
  };
}
