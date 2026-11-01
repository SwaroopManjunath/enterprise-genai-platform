import type { AuthenticatedPrincipal, OboTokenClient } from '@genai/auth';
import type { Guardrails } from '@genai/guardrails';
import { DownstreamError } from '@genai/shared';
import { z } from 'zod';
import type { McpGatewayClient, McpToolView } from '../clients/service-clients';
import { truncate } from '../runner/util';
import { ToolError, type AnyTool, type Tool } from './tool';
import type { ToolSource } from './tool-catalog';

const asAny = <T>(tool: Tool<T>): AnyTool => tool as unknown as AnyTool;

/** A short signature for the model, from the schema's own property list. */
export function describeSchema(schema: Record<string, unknown>): string {
  const properties = schema['properties'];
  if (!properties || typeof properties !== 'object') return '{}';
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );
  const fields = Object.entries(properties as Record<string, { type?: unknown }>)
    .slice(0, 12)
    .map(([name, spec]) => {
      const type = typeof spec?.type === 'string' ? spec.type : 'any';
      return `"${name}"${required.has(name) ? '' : '?'}: ${type}`;
    });
  return truncate(`{${fields.join(', ')}}`, 300);
}

/**
 * Turns what the MCP gateway allows this user into agent tools. The gateway has already checked
 * roles, approval and definitions; the agent adds nothing to widen that, and applies its own
 * screen to the descriptions anyway, because they are text a third party wrote that the model will
 * read.
 */
export class McpToolSource implements ToolSource {
  constructor(
    private readonly gateway: McpGatewayClient,
    private readonly obo: OboTokenClient,
    private readonly scope: string,
    private readonly guardrails: Guardrails,
  ) {}

  async toolsFor(caller: AuthenticatedPrincipal): Promise<AnyTool[]> {
    const token = await this.obo.exchange(caller.accessToken, this.scope);
    const views = await this.gateway.listTools(token, `list-${caller.userId}`);

    const screened = this.guardrails.screenSources(
      views.map((v) => ({ text: `${v.name} ${v.description}`, view: v })),
    );
    return screened.kept.map(({ view }) => this.wrap(view));
  }

  private wrap(view: McpToolView): AnyTool {
    return asAny({
      name: view.id,
      description: truncate(view.description || `Tool ${view.name} on ${view.server}`, 300),
      risk: view.risk,
      requiredRoles: [],
      // The gateway validates against the server's schema; here only the shape is fixed.
      input: z.record(z.string(), z.unknown()),
      parametersHelp: describeSchema(view.inputSchema),
      describe: (args: Record<string, unknown>) =>
        `Call ${view.server}/${view.name} with ${truncate(JSON.stringify(args), 200)}`,
      execute: async (args: Record<string, unknown>, ctx) => {
        const token = await ctx.tokenFor(this.scope);
        try {
          const result = await this.gateway.call(
            token,
            { server: view.server, tool: view.name, arguments: args },
            ctx.idempotencyKey,
          );
          if (result.withheld) throw new ToolError('the tool result was withheld by the gateway');
          return result.isError ? { error: result.content } : { result: result.content };
        } catch (error) {
          throw translate(error);
        }
      },
    });
  }
}

/** What the model may be told about a gateway refusal. Everything else stays a generic failure. */
function translate(error: unknown): unknown {
  if (!(error instanceof DownstreamError) || error.kind !== 'http') return error;
  if (error.status === 400 && error.code === 'invalid_arguments') {
    return new ToolError('the arguments do not match the tool input schema');
  }
  if (error.status === 404) return new ToolError('the tool is not available');
  if (error.status === 409 && error.code === 'tool_changed') {
    return new ToolError('the tool is under review and cannot be used right now');
  }
  if (error.status === 429) return new ToolError('the tool is rate limited, try again later');
  return error;
}
