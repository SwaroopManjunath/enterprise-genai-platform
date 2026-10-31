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
  })
  .refine((e) => e.CHUNK_OVERLAP_CHARS < e.CHUNK_MAX_CHARS, {
    message: 'CHUNK_OVERLAP_CHARS must be smaller than CHUNK_MAX_CHARS',
  });

export interface IngestionConfig {
  port: number;
  pollIntervalMs: number;
  visibilityTimeoutMs: number;
  maxDeliveries: number;
  retry: { baseDelayMs: number; maxDelayMs: number };
  chunking: { maxChars: number; overlapChars: number };
  maxDocumentBytes: number;
}

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
  };
}
