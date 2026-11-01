import { ConcurrentUpdateError } from '../domain/errors';
import type { McpServer } from '../domain/types';
import { InMemoryAuditStore, InMemoryRegistryStore } from './stores';

const server = (overrides: Partial<McpServer> = {}): McpServer => ({
  id: 'crm',
  tenantId: 'acme',
  name: 'CRM',
  url: 'https://crm.example',
  auth: { kind: 'none' },
  enabled: true,
  tools: [],
  createdBy: 'admin',
  createdAt: 't',
  lastVerifiedAt: 0,
  revision: 0,
  ...overrides,
});

describe('InMemoryRegistryStore', () => {
  it('saves, bumps the revision and reads back a copy', async () => {
    const store = new InMemoryRegistryStore();

    const saved = await store.save(server());
    const read = (await store.get('acme', 'crm')) as McpServer;
    read.enabled = false;

    expect(saved.revision).toBe(1);
    expect((await store.get('acme', 'crm'))?.enabled).toBe(true);
  });

  it('rejects a stale save: two admins cannot overwrite each other', async () => {
    const store = new InMemoryRegistryStore();
    const first = await store.save(server());
    await store.save({ ...first, name: 'CRM v2' });

    await expect(store.save({ ...first, name: 'CRM v3' })).rejects.toBeInstanceOf(
      ConcurrentUpdateError,
    );
    expect((await store.get('acme', 'crm'))?.name).toBe('CRM v2');
  });

  it('is tenant-scoped for get and list', async () => {
    const store = new InMemoryRegistryStore();
    await store.save(server());
    await store.save(server({ tenantId: 'globex', url: 'https://other.example' }));

    expect(await store.get('globex', 'crm').then((s) => s?.url)).toBe('https://other.example');
    expect((await store.list('acme')).map((s) => s.url)).toEqual(['https://crm.example']);
    expect(await store.list('nobody')).toEqual([]);
  });

  it('deletes only within the tenant', async () => {
    const store = new InMemoryRegistryStore();
    await store.save(server());

    await store.delete('globex', 'crm');
    expect(await store.get('acme', 'crm')).toBeDefined();
    await store.delete('acme', 'crm');
    expect(await store.get('acme', 'crm')).toBeUndefined();
  });
});

describe('InMemoryAuditStore', () => {
  const entry = (overrides = {}) => ({
    at: 't',
    tenantId: 'acme',
    userId: 'alice',
    action: 'tool_call' as const,
    outcome: 'ok' as const,
    server: 'crm',
    ...overrides,
  });

  it('returns newest first, tenant-scoped, and filters', async () => {
    const store = new InMemoryAuditStore();
    await store.append(entry({ tool: 'first' }));
    await store.append(entry({ tool: 'second', outcome: 'denied', userId: 'bob' }));
    await store.append(entry({ tenantId: 'globex', tool: 'other-tenant' }));

    const all = await store.query('acme', { limit: 10 });
    expect(all.map((e) => e.tool)).toEqual(['second', 'first']);
    expect(
      (await store.query('acme', { limit: 10, outcome: 'denied' })).map((e) => e.tool),
    ).toEqual(['second']);
    expect((await store.query('acme', { limit: 10, userId: 'alice' })).map((e) => e.tool)).toEqual([
      'first',
    ]);
    expect(await store.query('acme', { limit: 1 })).toHaveLength(1);
  });

  it('has no way to change or remove an entry', () => {
    const store = new InMemoryAuditStore() as unknown as Record<string, unknown>;

    expect(store['update']).toBeUndefined();
    expect(store['delete']).toBeUndefined();
  });
});
