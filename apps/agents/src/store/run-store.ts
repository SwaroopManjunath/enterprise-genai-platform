import { ConcurrentRunUpdateError } from '../domain/errors';
import type { Run } from '../domain/types';

/**
 * Where runs live between requests. Because a run can wait for a person for hours, its whole
 * state (transcript, queued calls, pending approval, audit events) is stored here and the runner
 * holds nothing in memory: any replica, or a restarted process with a durable store, can resume it.
 * The in-memory adapter below is for development and tests; Cosmos DB (partitioned by tenant) is
 * the production target.
 */
export interface RunStore {
  /** Tenant-scoped: a run id from another tenant is simply not found. */
  get(tenantId: string, runId: string): Promise<Run | undefined>;
  /**
   * Saves only if the stored revision still equals `run.revision` (new runs start at 0), then
   * increments it. Throws ConcurrentRunUpdateError otherwise. This is what makes an approval
   * execute a write action exactly once even if two approvals race.
   */
  save(run: Run): Promise<Run>;
}

export const RUN_STORE = Symbol('RUN_STORE');

export class InMemoryRunStore implements RunStore {
  private readonly byTenant = new Map<string, Map<string, Run>>();

  get(tenantId: string, runId: string): Promise<Run | undefined> {
    const run = this.byTenant.get(tenantId)?.get(runId);
    return Promise.resolve(run && structuredClone(run));
  }

  save(run: Run): Promise<Run> {
    const tenant = this.byTenant.get(run.tenantId) ?? new Map<string, Run>();
    const storedRevision = tenant.get(run.id)?.revision ?? 0;
    if (storedRevision !== run.revision) {
      return Promise.reject(new ConcurrentRunUpdateError(run.id));
    }

    const saved = structuredClone({ ...run, revision: run.revision + 1 });
    tenant.set(run.id, saved);
    this.byTenant.set(run.tenantId, tenant);
    return Promise.resolve(structuredClone(saved));
  }
}
