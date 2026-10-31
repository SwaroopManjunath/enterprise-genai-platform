import { ConcurrentRunUpdateError } from '../domain/errors';
import type { Run } from '../domain/types';
import { InMemoryRunStore } from './run-store';

const newRun = (overrides: Partial<Run> = {}): Run => ({
  id: 'run-1',
  tenantId: 'acme',
  ownerId: 'alice',
  goal: 'do something',
  status: 'running',
  steps: 0,
  maxSteps: 6,
  deadlineAt: 0,
  transcript: [],
  queue: [],
  callCounts: {},
  consecutiveModelErrors: 0,
  nextCallNumber: 1,
  events: [],
  createdAt: 't',
  updatedAt: 't',
  revision: 0,
  ...overrides,
});

describe('InMemoryRunStore', () => {
  it('saves and reads back, bumping the revision', async () => {
    const store = new InMemoryRunStore();

    const saved = await store.save(newRun());

    expect(saved.revision).toBe(1);
    expect((await store.get('acme', 'run-1'))?.revision).toBe(1);
  });

  it('rejects a stale save: two writers cannot both win', async () => {
    const store = new InMemoryRunStore();
    const first = await store.save(newRun());
    await store.save({ ...first, status: 'completed' }); // someone else moves revision 1 -> 2

    await expect(store.save({ ...first, status: 'failed' })).rejects.toBeInstanceOf(
      ConcurrentRunUpdateError,
    );
    expect((await store.get('acme', 'run-1'))?.status).toBe('completed');
  });

  it('lets exactly one of two racing saves succeed', async () => {
    const store = new InMemoryRunStore();
    const first = await store.save(newRun());

    const results = await Promise.allSettled([
      store.save({ ...first, answer: 'a' }),
      store.save({ ...first, answer: 'b' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('is tenant-scoped: another tenant cannot read a run', async () => {
    const store = new InMemoryRunStore();
    await store.save(newRun());

    expect(await store.get('globex', 'run-1')).toBeUndefined();
  });

  it('returns copies so callers cannot mutate stored state', async () => {
    const store = new InMemoryRunStore();
    await store.save(newRun());

    const read = (await store.get('acme', 'run-1')) as Run;
    read.status = 'completed';

    expect((await store.get('acme', 'run-1'))?.status).toBe('running');
  });
});
