import { randomUUID } from 'node:crypto';
import { ConcurrentUpdateError } from '../domain/errors';
import type { AuditEntry, McpServer } from '../domain/types';

/**
 * Where registered servers live. Tenant-scoped: another tenant's server id is simply not found.
 * The in-memory adapter is for development and tests; Cosmos DB (partitioned by tenant) is the
 * production target.
 */
export interface RegistryStore {
  get(tenantId: string, serverId: string): Promise<McpServer | undefined>;
  list(tenantId: string): Promise<McpServer[]>;
  /**
   * Saves only if the stored revision still equals `server.revision` (new servers start at 0),
   * then increments it, so two admins editing at once cannot overwrite each other.
   */
  save(server: McpServer): Promise<McpServer>;
  delete(tenantId: string, serverId: string): Promise<void>;
}

export const REGISTRY_STORE = Symbol('REGISTRY_STORE');

export class InMemoryRegistryStore implements RegistryStore {
  private readonly byTenant = new Map<string, Map<string, McpServer>>();

  get(tenantId: string, serverId: string): Promise<McpServer | undefined> {
    const server = this.byTenant.get(tenantId)?.get(serverId);
    return Promise.resolve(server && structuredClone(server));
  }

  list(tenantId: string): Promise<McpServer[]> {
    const servers = [...(this.byTenant.get(tenantId)?.values() ?? [])];
    return Promise.resolve(structuredClone(servers).sort((a, b) => a.id.localeCompare(b.id)));
  }

  save(server: McpServer): Promise<McpServer> {
    const tenant = this.byTenant.get(server.tenantId) ?? new Map<string, McpServer>();
    const stored = tenant.get(server.id)?.revision ?? 0;
    if (stored !== server.revision) return Promise.reject(new ConcurrentUpdateError(server.id));

    const saved = structuredClone({ ...server, revision: server.revision + 1 });
    tenant.set(server.id, saved);
    this.byTenant.set(server.tenantId, tenant);
    return Promise.resolve(structuredClone(saved));
  }

  delete(tenantId: string, serverId: string): Promise<void> {
    this.byTenant.get(tenantId)?.delete(serverId);
    return Promise.resolve();
  }
}

export interface AuditQuery {
  limit: number;
  server?: string;
  userId?: string;
  action?: string;
  outcome?: string;
}

/**
 * The audit log is append-only by construction: the interface has no update or delete. Reads are
 * tenant-scoped and newest first.
 */
export interface AuditStore {
  append(entry: Omit<AuditEntry, 'id'>): Promise<void>;
  query(tenantId: string, query: AuditQuery): Promise<AuditEntry[]>;
}

export const AUDIT_STORE = Symbol('AUDIT_STORE');

export class InMemoryAuditStore implements AuditStore {
  private readonly entries: AuditEntry[] = [];

  append(entry: Omit<AuditEntry, 'id'>): Promise<void> {
    this.entries.push({ id: randomUUID(), ...entry });
    return Promise.resolve();
  }

  query(tenantId: string, query: AuditQuery): Promise<AuditEntry[]> {
    const matches = this.entries
      .filter((e) => e.tenantId === tenantId)
      .filter((e) => !query.server || e.server === query.server)
      .filter((e) => !query.userId || e.userId === query.userId)
      .filter((e) => !query.action || e.action === query.action)
      .filter((e) => !query.outcome || e.outcome === query.outcome)
      .reverse()
      .slice(0, query.limit);
    return Promise.resolve(structuredClone(matches));
  }
}
