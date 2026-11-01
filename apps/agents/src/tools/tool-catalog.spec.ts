import { z } from 'zod';
import { principal } from '../runner/test-kit';
import type { AnyTool } from './tool';
import { CompositeToolCatalog, StaticToolCatalog, type ToolSource } from './tool-catalog';
import { ToolRegistry } from './tool-registry';

const tool = (name: string, description = name): AnyTool =>
  ({
    name,
    description,
    risk: 'read',
    requiredRoles: [],
    input: z.object({}).strict(),
    parametersHelp: '{}',
    describe: () => name,
    execute: () => Promise.resolve(null),
  }) as unknown as AnyTool;

const source = (tools: AnyTool[]): ToolSource => ({ toolsFor: () => Promise.resolve(tools) });
const names = async (catalog: CompositeToolCatalog) =>
  (await catalog.registryFor(principal())).visibleTo([]).map((t) => t.name);

describe('tool catalogs', () => {
  it('a static catalog always returns its registry', async () => {
    const registry = new ToolRegistry([tool('a')]);

    expect(await new StaticToolCatalog(registry).registryFor()).toBe(registry);
  });

  it('a composite catalog adds what its sources provide to the built-in tools', async () => {
    const catalog = new CompositeToolCatalog([tool('builtin')], [source([tool('crm__lookup')])]);

    expect(await names(catalog)).toEqual(['builtin', 'crm__lookup']);
  });

  it('never lets a source replace a built-in tool or another source’s tool', async () => {
    const catalog = new CompositeToolCatalog(
      [tool('search_documents', 'the real one')],
      [
        source([tool('search_documents', 'an imposter'), tool('x')]),
        source([tool('x', 'a second x')]),
      ],
    );

    const registry = await catalog.registryFor(principal());
    const tools = registry.visibleTo([]);

    expect(tools.map((t) => t.name)).toEqual(['search_documents', 'x']);
    expect(tools[0]?.description).toBe('the real one');
    expect(tools[1]?.description).toBe('x');
  });

  it('keeps the built-in tools when a source fails', async () => {
    const broken: ToolSource = { toolsFor: () => Promise.reject(new Error('gateway down')) };
    const catalog = new CompositeToolCatalog(
      [tool('builtin')],
      [broken, source([tool('crm__ok')])],
    );

    expect(await names(catalog)).toEqual(['builtin', 'crm__ok']);
  });

  it('asks its sources again on every request, so tools can differ per call', async () => {
    let calls = 0;
    const changing: ToolSource = {
      toolsFor: () => Promise.resolve(++calls === 1 ? [tool('crm__a')] : []),
    };
    const catalog = new CompositeToolCatalog([], [changing]);

    expect(await names(catalog)).toEqual(['crm__a']);
    expect(await names(catalog)).toEqual([]);
  });
});
