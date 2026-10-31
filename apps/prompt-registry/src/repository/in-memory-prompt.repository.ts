import { ConcurrentModificationError } from '../domain/errors';
import type { PromptRecord } from '../domain/types';
import type { PromptRepository } from './prompt.repository';

/**
 * Keyed by tenant, then name, so one tenant can never read or overwrite another's prompts.
 * Records are cloned on the way in and out: callers cannot mutate stored (immutable) versions.
 */
export class InMemoryPromptRepository implements PromptRepository {
  private readonly byTenant = new Map<string, Map<string, PromptRecord>>();

  get(tenantId: string, name: string): Promise<PromptRecord | undefined> {
    const stored = this.byTenant.get(tenantId)?.get(name);
    return Promise.resolve(stored && structuredClone(stored));
  }

  list(tenantId: string): Promise<PromptRecord[]> {
    const records = [...(this.byTenant.get(tenantId)?.values() ?? [])];
    return Promise.resolve(records.map((r) => structuredClone(r)));
  }

  save(record: PromptRecord): Promise<PromptRecord> {
    const tenant = this.byTenant.get(record.tenantId) ?? new Map<string, PromptRecord>();
    const storedRevision = tenant.get(record.name)?.revision ?? 0;
    if (storedRevision !== record.revision) {
      return Promise.reject(new ConcurrentModificationError(record.name));
    }

    const saved = structuredClone({ ...record, revision: record.revision + 1 });
    tenant.set(record.name, saved);
    this.byTenant.set(record.tenantId, tenant);
    return Promise.resolve(structuredClone(saved));
  }
}
