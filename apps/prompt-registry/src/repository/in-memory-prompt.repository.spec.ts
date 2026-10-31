import { ConcurrentModificationError } from '../domain/errors';
import type { PromptRecord } from '../domain/types';
import { InMemoryPromptRepository } from './in-memory-prompt.repository';

const record = (overrides: Partial<PromptRecord> = {}): PromptRecord => ({
  tenantId: 'acme',
  name: 'greeting',
  versions: [],
  activeVersion: undefined,
  history: [],
  revision: 0,
  ...overrides,
});

describe('InMemoryPromptRepository', () => {
  it('saves and reads back, bumping the revision', async () => {
    const repo = new InMemoryPromptRepository();

    const saved = await repo.save(record());

    expect(saved.revision).toBe(1);
    expect((await repo.get('acme', 'greeting'))?.revision).toBe(1);
  });

  it('rejects a stale write (optimistic concurrency)', async () => {
    const repo = new InMemoryPromptRepository();
    const first = await repo.save(record());
    await repo.save(first); // someone else saved revision 1 -> 2

    await expect(repo.save(first)).rejects.toBeInstanceOf(ConcurrentModificationError);
  });

  it('rejects creating a record that already exists', async () => {
    const repo = new InMemoryPromptRepository();
    await repo.save(record());

    await expect(repo.save(record())).rejects.toBeInstanceOf(ConcurrentModificationError);
  });

  it('isolates tenants', async () => {
    const repo = new InMemoryPromptRepository();
    await repo.save(record({ tenantId: 'acme' }));

    expect(await repo.get('globex', 'greeting')).toBeUndefined();
    expect(await repo.list('globex')).toEqual([]);
    expect(await repo.list('acme')).toHaveLength(1);
  });

  it('returns copies so callers cannot mutate stored data', async () => {
    const repo = new InMemoryPromptRepository();
    await repo.save(record({ activeVersion: 1 }));

    const read = await repo.get('acme', 'greeting');
    (read as PromptRecord).activeVersion = 99;

    expect((await repo.get('acme', 'greeting'))?.activeVersion).toBe(1);
  });
});
