import type { AuthenticatedPrincipal } from '@genai/auth';
import { Logger } from '@nestjs/common';
import type { AnyTool } from './tool';
import { ToolRegistry } from './tool-registry';

/**
 * Decides which tools exist for a caller. The runner asks once per request, so tools that come
 * from another service (the MCP gateway) can differ per user and over time, and are never assumed
 * to still be there later: approving an action looks the tool up again.
 */
export interface ToolCatalog {
  registryFor(caller: AuthenticatedPrincipal): Promise<ToolRegistry>;
}

export const TOOL_CATALOG = Symbol('TOOL_CATALOG');

/** A fixed set of tools, the same for everyone the registry's roles allow. */
export class StaticToolCatalog implements ToolCatalog {
  constructor(private readonly registry: ToolRegistry) {}

  registryFor(): Promise<ToolRegistry> {
    return Promise.resolve(this.registry);
  }
}

/** Where extra tools for a caller come from. */
export interface ToolSource {
  toolsFor(caller: AuthenticatedPrincipal): Promise<AnyTool[]>;
}

/**
 * Built-in tools plus those from other sources. A source that fails contributes nothing, so an
 * unavailable MCP gateway costs the agent those tools but not the run. A source cannot replace a
 * built-in tool: on a name clash the built-in wins.
 */
export class CompositeToolCatalog implements ToolCatalog {
  private readonly logger = new Logger('ToolCatalog');

  constructor(
    private readonly builtin: readonly AnyTool[],
    private readonly sources: readonly ToolSource[],
  ) {}

  async registryFor(caller: AuthenticatedPrincipal): Promise<ToolRegistry> {
    const names = new Set(this.builtin.map((t) => t.name));
    const extra: AnyTool[] = [];

    for (const source of this.sources) {
      let tools: AnyTool[] = [];
      try {
        tools = await source.toolsFor(caller);
      } catch (error) {
        this.logger.warn(`a tool source failed: ${String(error)}`);
      }
      for (const tool of tools) {
        if (names.has(tool.name)) continue;
        names.add(tool.name);
        extra.push(tool);
      }
    }
    return new ToolRegistry([...this.builtin, ...extra]);
  }
}
