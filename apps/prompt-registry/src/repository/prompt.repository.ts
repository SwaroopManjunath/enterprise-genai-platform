import type { PromptRecord } from '../domain/types';

/**
 * Storage port. Async so a real database (Cosmos DB, partitioned by tenant) can replace the
 * in-memory implementation without touching the service.
 */
export interface PromptRepository {
  get(tenantId: string, name: string): Promise<PromptRecord | undefined>;
  list(tenantId: string): Promise<PromptRecord[]>;
  /**
   * Persists `record` only if the stored revision still equals `record.revision` (new records
   * start at revision 0). Throws ConcurrentModificationError otherwise. Returns the saved record.
   */
  save(record: PromptRecord): Promise<PromptRecord>;
}

export const PROMPT_REPOSITORY = Symbol('PROMPT_REPOSITORY');
