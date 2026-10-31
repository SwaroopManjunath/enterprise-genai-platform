import { InvalidExperimentError, VersionNotFoundError } from '../domain/errors';
import { MissingVariablesError } from '../domain/template';
import { InMemoryPromptRepository } from '../repository/in-memory-prompt.repository';
import { PromptRegistryService } from './prompt-registry.service';

async function setup() {
  let tick = 0;
  const service = new PromptRegistryService(
    new InMemoryPromptRepository(),
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  );
  await service.createVersion('acme', 'summary', { template: 'v1: {{doc}}' });
  await service.createVersion('acme', 'summary', { template: 'v2: {{doc}}' });
  return service;
}

const variables = { doc: 'report' };

describe('PromptRegistryService.resolve', () => {
  it('renders the active version when there is no experiment', async () => {
    const service = await setup();

    const result = await service.resolve('acme', 'summary', { variables });

    expect(result).toEqual({
      name: 'summary',
      version: 1,
      inExperiment: false,
      rendered: 'v1: report',
    });
  });

  it('follows the active pointer after a rollback', async () => {
    const service = await setup();
    await service.activate('acme', 'summary', 2);
    expect((await service.resolve('acme', 'summary', { variables })).rendered).toBe('v2: report');

    await service.activate('acme', 'summary', 1);
    expect((await service.resolve('acme', 'summary', { variables })).rendered).toBe('v1: report');
  });

  it('fails with the list of missing variables', async () => {
    const service = await setup();
    await expect(service.resolve('acme', 'summary', { variables: {} })).rejects.toBeInstanceOf(
      MissingVariablesError,
    );
  });
});

describe('PromptRegistryService experiments', () => {
  it('assigns a stable variant per subject and uses both variants across subjects', async () => {
    const service = await setup();
    await service.setExperiment('acme', 'summary', [
      { version: 1, weight: 1 },
      { version: 2, weight: 1 },
    ]);

    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const subjectKey = `user-${i}`;
      const first = await service.resolve('acme', 'summary', { variables, subjectKey });
      const again = await service.resolve('acme', 'summary', { variables, subjectKey });
      expect(again.version).toBe(first.version);
      expect(first.inExperiment).toBe(true);
      seen.add(first.version);
    }
    expect(seen).toEqual(new Set([1, 2]));
  });

  it('serves the active version when no subject key is given (cannot be sticky)', async () => {
    const service = await setup();
    await service.setExperiment('acme', 'summary', [
      { version: 1, weight: 1 },
      { version: 2, weight: 1 },
    ]);

    for (let i = 0; i < 20; i++) {
      const result = await service.resolve('acme', 'summary', { variables });
      expect(result).toMatchObject({ version: 1, inExperiment: false });
    }
  });

  it('stops splitting traffic once the experiment is cleared', async () => {
    const service = await setup();
    await service.setExperiment('acme', 'summary', [
      { version: 1, weight: 1 },
      { version: 2, weight: 99 },
    ]);
    await service.clearExperiment('acme', 'summary');

    const result = await service.resolve('acme', 'summary', { variables, subjectKey: 'user-1' });

    expect(result).toMatchObject({ version: 1, inExperiment: false });
  });

  it('reshuffles assignment when a new experiment starts', async () => {
    const service = await setup();
    const variants = [
      { version: 1, weight: 1 },
      { version: 2, weight: 1 },
    ];
    await service.setExperiment('acme', 'summary', variants);
    const before: number[] = [];
    for (let i = 0; i < 100; i++) {
      before.push(
        (await service.resolve('acme', 'summary', { variables, subjectKey: `u${i}` })).version,
      );
    }

    await service.setExperiment('acme', 'summary', variants); // new startedAt
    const after: number[] = [];
    for (let i = 0; i < 100; i++) {
      after.push(
        (await service.resolve('acme', 'summary', { variables, subjectKey: `u${i}` })).version,
      );
    }

    expect(after).not.toEqual(before);
  });

  it.each([
    ['fewer than two variants', [{ version: 1, weight: 1 }]],
    [
      'duplicate versions',
      [
        { version: 1, weight: 1 },
        { version: 1, weight: 2 },
      ],
    ],
    [
      'zero weight',
      [
        { version: 1, weight: 0 },
        { version: 2, weight: 1 },
      ],
    ],
    [
      'fractional weight',
      [
        { version: 1, weight: 0.5 },
        { version: 2, weight: 1 },
      ],
    ],
  ])('rejects an experiment with %s', async (_label, variants) => {
    const service = await setup();
    await expect(service.setExperiment('acme', 'summary', variants)).rejects.toBeInstanceOf(
      InvalidExperimentError,
    );
  });

  it('rejects an experiment that references a missing version', async () => {
    const service = await setup();
    await expect(
      service.setExperiment('acme', 'summary', [
        { version: 1, weight: 1 },
        { version: 9, weight: 1 },
      ]),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });
});
