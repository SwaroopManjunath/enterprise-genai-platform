import type { AnyTool } from './tool';

/**
 * The only way the agent reaches a tool. A caller sees, and can use, just the tools their roles
 * allow: the model is never told about the others, and a call to one is refused as if it did not
 * exist, so permissions are enforced here and not left to the model's good behaviour.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, AnyTool>();

  constructor(tools: readonly AnyTool[]) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) throw new Error(`Duplicate tool "${tool.name}"`);
      this.byName.set(tool.name, tool);
    }
  }

  visibleTo(roles: readonly string[]): AnyTool[] {
    return [...this.byName.values()].filter((tool) => allowed(tool, roles));
  }

  /** The tool, or undefined if it is unknown or the roles do not allow it (the two are indistinguishable). */
  resolve(name: string, roles: readonly string[]): AnyTool | undefined {
    const tool = this.byName.get(name);
    return tool && allowed(tool, roles) ? tool : undefined;
  }
}

function allowed(tool: AnyTool, roles: readonly string[]): boolean {
  return tool.requiredRoles.length === 0 || tool.requiredRoles.some((role) => roles.includes(role));
}
