import {
  ConcurrentModificationError,
  InvalidPromptError,
  PromptNotFoundError,
  VersionNotFoundError,
} from '../domain/errors';
import { InMemoryPromptRepository } from '../repository/in-memory-prompt.repository';
import { PromptRegistryService } from './prompt-registry.service';

function setup() {
  const repo = new InMemoryPromptRepository();
  let tick = 0;
  const service = new PromptRegistryService(
    repo,
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  );
  return { repo, service };
}

describe('PromptRegistryService versioning', () => {
  it('numbers versions from 1 and activates the first one automatically', async () => {
    const { service } = setup();

    const v1 = await service.createVersion('acme', 'summary', { template: 'Summarise {{doc}}' });
    const record = await service.get('acme', 'summary');

    expect(v1.version).toBe(1);
    expect(v1.variables).toEqual(['doc']);
    expect(record.activeVersion).toBe(1);
    expect(record.history).toMatchObject([{ kind: 'initial', toVersion: 1 }]);
  });

  it('keeps later versions inactive until explicitly activated', async () => {
    const { service } = setup();
    await service.createVersion('acme', 'summary', { template: 'v1 {{doc}}' });

    const v2 = await service.createVersion('acme', 'summary', { template: 'v2 {{doc}}' });
    const record = await service.get('acme', 'summary');

    expect(v2.version).toBe(2);
    expect(record.activeVersion).toBe(1);
    expect(record.versions).toHaveLength(2);
  });

  it('never rewrites an existing version when a new one is added', async () => {
    const { service } = setup();
    const v1 = await service.createVersion('acme', 'summary', { template: 'original' });
    await service.createVersion('acme', 'summary', { template: 'changed' });

    expect(await service.getVersion('acme', 'summary', 1)).toEqual(v1);
  });

  it.each(['Has Caps', '', '-leading', 'a'.repeat(65), 'with space'])(
    'rejects invalid prompt name %p',
    async (name) => {
      const { service } = setup();
      await expect(service.createVersion('acme', name, { template: 'x' })).rejects.toBeInstanceOf(
        InvalidPromptError,
      );
    },
  );

  it('rejects empty and oversized templates', async () => {
    const { service } = setup();
    await expect(service.createVersion('acme', 'p', { template: '   ' })).rejects.toBeInstanceOf(
      InvalidPromptError,
    );
    await expect(
      service.createVersion('acme', 'p', { template: 'x'.repeat(50_001) }),
    ).rejects.toBeInstanceOf(InvalidPromptError);
  });

  it('scopes prompts to the tenant', async () => {
    const { service } = setup();
    await service.createVersion('acme', 'summary', { template: 'acme only' });

    await expect(service.get('globex', 'summary')).rejects.toBeInstanceOf(PromptNotFoundError);
    expect(await service.list('globex')).toEqual([]);
  });

  it('reports not found for unknown prompts and versions', async () => {
    const { service } = setup();
    await expect(service.get('acme', 'nope')).rejects.toBeInstanceOf(PromptNotFoundError);

    await service.createVersion('acme', 'summary', { template: 'x' });
    await expect(service.getVersion('acme', 'summary', 9)).rejects.toBeInstanceOf(
      VersionNotFoundError,
    );
  });
});

describe('PromptRegistryService activation and rollback', () => {
  async function withThreeVersions() {
    const ctx = setup();
    for (const t of ['one', 'two', 'three']) {
      await ctx.service.createVersion('acme', 'summary', { template: t });
    }
    return ctx;
  }

  it('activates a newer version and records who did it', async () => {
    const { service } = await withThreeVersions();

    const record = await service.activate('acme', 'summary', 3, 'swaroop');

    expect(record.activeVersion).toBe(3);
    expect(record.history.at(-1)).toMatchObject({
      kind: 'activate',
      fromVersion: 1,
      toVersion: 3,
      by: 'swaroop',
    });
  });

  it('records moving to an older version as a rollback, keeping all versions', async () => {
    const { service } = await withThreeVersions();
    await service.activate('acme', 'summary', 3);

    const record = await service.activate('acme', 'summary', 2, 'oncall');

    expect(record.activeVersion).toBe(2);
    expect(record.history.at(-1)).toMatchObject({ kind: 'rollback', fromVersion: 3, toVersion: 2 });
    expect(record.versions).toHaveLength(3);
  });

  it('is a no-op (no new history entry) when the version is already active', async () => {
    const { service } = await withThreeVersions();
    const before = await service.get('acme', 'summary');

    const after = await service.activate('acme', 'summary', 1);

    expect(after.history).toHaveLength(before.history.length);
    expect(after.revision).toBe(before.revision);
  });

  it('refuses to activate a version that does not exist', async () => {
    const { service } = await withThreeVersions();
    await expect(service.activate('acme', 'summary', 7)).rejects.toBeInstanceOf(
      VersionNotFoundError,
    );
  });

  it('surfaces a concurrent edit instead of silently overwriting it', async () => {
    const { repo, service } = await withThreeVersions();
    const stale = await repo.get('acme', 'summary');
    await service.activate('acme', 'summary', 2); // another writer moves the revision on

    stale!.activeVersion = 3;
    await expect(repo.save(stale!)).rejects.toBeInstanceOf(ConcurrentModificationError);
  });
});
