import { z } from 'zod';
import type { AnyTool } from './tool';
import { ToolRegistry } from './tool-registry';

const tool = (name: string, requiredRoles: string[]): AnyTool =>
  ({
    name,
    description: name,
    risk: 'read',
    requiredRoles,
    input: z.object({}).strict(),
    parametersHelp: '{}',
    describe: () => name,
    execute: () => Promise.resolve(null),
  }) as unknown as AnyTool;

describe('ToolRegistry', () => {
  const registry = new ToolRegistry([
    tool('open', []),
    tool('staff', ['support']),
    tool('lead', ['support-lead']),
  ]);

  it('shows a caller only the tools their roles allow', () => {
    expect(registry.visibleTo([]).map((t) => t.name)).toEqual(['open']);
    expect(registry.visibleTo(['support']).map((t) => t.name)).toEqual(['open', 'staff']);
    expect(registry.visibleTo(['support', 'support-lead']).map((t) => t.name)).toEqual([
      'open',
      'staff',
      'lead',
    ]);
  });

  it('resolves a forbidden tool exactly like an unknown one', () => {
    expect(registry.resolve('lead', ['support'])).toBeUndefined();
    expect(registry.resolve('nope', ['support'])).toBeUndefined();
    expect(registry.resolve('staff', ['support'])?.name).toBe('staff');
  });

  it('refuses two tools with the same name', () => {
    expect(() => new ToolRegistry([tool('a', []), tool('a', [])])).toThrow(/Duplicate/);
  });
});
