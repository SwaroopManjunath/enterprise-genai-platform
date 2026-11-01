import type { AuthenticatedPrincipal } from '@genai/auth';
import type { Guardrails } from '@genai/guardrails';
import { digest } from '@genai/shared';
import {
  ConcurrentUpdateError,
  InvalidArgumentsError,
  RateLimitedError,
  ToolChangedError,
  ToolNotAvailableError,
  UpstreamError,
} from '../domain/errors';
import type { AuditOutcome, McpServer, ToolRecord, ToolRisk } from '../domain/types';
import type { McpClient, RawToolResult } from '../mcp/mcp-client';
import type { SchemaValidator } from '../mcp/schema-validator';
import type { AuditLog } from '../registry/audit-log';
import type { RegistryService } from '../registry/registry-service';
import type { UpstreamAuth } from '../registry/upstream-auth';
import type { RegistryStore } from '../store/stores';
import type { RateLimiter } from './rate-limiter';

export interface InvokerDeps {
  store: RegistryStore;
  registry: RegistryService;
  audit: AuditLog;
  client: McpClient;
  auth: UpstreamAuth;
  validator: SchemaValidator;
  guardrails: Guardrails;
  limiter: RateLimiter;
  limits: { verifyTtlMs: number; maxResultChars: number };
  now: () => number;
}

/** A tool the caller may use, as shown to a person or an agent. */
export interface ToolView {
  /** `<server>__<tool>`: server ids never contain an underscore, so this splits unambiguously. */
  id: string;
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
}

export interface CallResult {
  /** Text only, redacted and size-limited. Empty when the result was withheld. */
  content: string;
  /** The tool itself reported a failure (as opposed to the gateway failing to call it). */
  isError: boolean;
  /** The result looked like instructions aimed at the model and was not returned. */
  withheld: boolean;
  truncated: boolean;
  redacted: boolean;
  durationMs: number;
}

const roleAllowed = (tool: ToolRecord, roles: readonly string[]): boolean => {
  const allowed = tool.policy?.allowedRoles ?? [];
  return allowed.length === 0 || allowed.some((role) => roles.includes(role));
};

/**
 * Runs a tool call through every check, in an order that reveals nothing to a caller who should
 * not know a tool exists: unknown, unapproved, disabled and not-permitted all look the same. Only
 * a caller who IS permitted learns that a tool changed and is waiting for review.
 */
export class ToolInvoker {
  constructor(private readonly deps: InvokerDeps) {}

  /** The tools this caller may use right now. */
  async listFor(caller: AuthenticatedPrincipal): Promise<ToolView[]> {
    const servers = await this.deps.store.list(caller.tenantId);
    return servers
      .filter((s) => s.enabled)
      .flatMap((server) =>
        server.tools
          .filter(
            (t) => t.status === 'approved' && t.policy?.enabled && roleAllowed(t, caller.roles),
          )
          .map((t) => ({
            id: `${server.id}__${t.name}`,
            server: server.id,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            risk: t.policy?.risk ?? 'write',
          })),
      );
  }

  async call(
    caller: AuthenticatedPrincipal,
    input: { server: string; tool: string; arguments: Record<string, unknown> },
    requestId: string,
  ): Promise<CallResult> {
    const started = this.deps.now();
    const base = {
      tenantId: caller.tenantId,
      userId: caller.userId,
      action: 'tool_call' as const,
      server: input.server,
      tool: input.tool,
      argsDigest: digest(input.arguments),
      requestId,
    };
    const deny = async (outcome: AuditOutcome, reason: string): Promise<never> => {
      await this.deps.audit.record({
        ...base,
        outcome,
        reason,
        durationMs: this.deps.now() - started,
      });
      throw outcome === 'tool_changed' ? new ToolChangedError() : new ToolNotAvailableError(reason);
    };

    try {
      this.deps.limiter.take(`${caller.tenantId}:${caller.userId}`);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        await this.deps.audit.record({ ...base, outcome: 'rate_limited' });
      }
      throw error;
    }

    let server = await this.deps.store.get(caller.tenantId, input.server);
    if (!server) return deny('not_found', 'unknown_server');
    if (!server.enabled) return deny('denied', 'server_disabled');

    server = await this.verified(server, caller, requestId, base, started);

    const tool = server.tools.find((t) => t.name === input.tool);
    if (!tool?.policy) return deny('denied', 'not_approved');
    if (!roleAllowed(tool, caller.roles)) return deny('denied', 'role_not_allowed');
    if (tool.status === 'changed') return deny('tool_changed', 'definition_changed');
    if (tool.status !== 'approved') return deny('denied', `status_${tool.status}`);
    if (!tool.policy.enabled) return deny('denied', 'tool_disabled');

    const issues = this.deps.validator.check(tool.hash, tool.inputSchema, input.arguments);
    if (issues.length > 0) {
      await this.deps.audit.record({
        ...base,
        outcome: 'invalid_arguments',
        reason: `${issues.length} issue(s)`,
        durationMs: this.deps.now() - started,
      });
      throw new InvalidArgumentsError(issues);
    }

    let raw: RawToolResult;
    try {
      const bearer = await this.deps.auth.bearerFor(server.auth, caller);
      raw = await this.deps.client.callTool(
        { url: server.url, ...(bearer && { bearer }) },
        tool.name,
        input.arguments,
      );
    } catch (error) {
      await this.deps.audit.record({
        ...base,
        outcome: 'upstream_error',
        reason: error instanceof UpstreamError ? `upstream_${error.kind}` : 'error',
        durationMs: this.deps.now() - started,
      });
      throw error;
    }

    const processed = this.process(raw);
    const durationMs = this.deps.now() - started;
    await this.deps.audit.record({
      ...base,
      outcome: raw.isError ? 'tool_error' : 'ok',
      durationMs,
      resultChars: processed.content.length,
      withheld: processed.withheld,
      redacted: processed.redacted,
    });
    return { ...processed, isError: raw.isError, durationMs };
  }

  /**
   * Makes sure the tool list is recent enough to trust. Past the verify interval the list is
   * re-read first, so a definition that changed since the last look is caught before the call, not
   * after. If it cannot be re-read, the call fails closed.
   */
  private async verified(
    server: McpServer,
    caller: AuthenticatedPrincipal,
    requestId: string,
    base: object,
    started: number,
  ): Promise<McpServer> {
    if (this.deps.now() - server.lastVerifiedAt < this.deps.limits.verifyTtlMs) return server;

    try {
      const bearer = await this.deps.auth.bearerFor(server.auth, caller);
      return (await this.deps.registry.reconcile(server, caller, bearer, requestId)).server;
    } catch (error) {
      if (error instanceof ConcurrentUpdateError) {
        // Another call re-verified at the same moment; use what it saved.
        const fresh = await this.deps.store.get(server.tenantId, server.id);
        if (fresh) return fresh;
      }
      await this.deps.audit.record({
        ...(base as Parameters<AuditLog['record']>[0]),
        outcome: 'upstream_error',
        reason: 'verification_failed',
        durationMs: this.deps.now() - started,
      });
      throw error;
    }
  }

  /**
   * A tool result is text written by a third party. Only text is passed on; it is cut to a fixed
   * size, screened for instructions aimed at the model (withheld if found) and redacted.
   */
  private process(raw: RawToolResult): Omit<CallResult, 'isError' | 'durationMs'> {
    const { guardrails } = this.deps;
    const text = raw.content
      .map((block) => {
        const b = block as { type?: unknown; text?: unknown };
        if (b?.type === 'text' && typeof b.text === 'string') return b.text;
        return `[${typeof b?.type === 'string' ? b.type : 'unknown'} content omitted]`;
      })
      .join('\n');

    const truncated = text.length > this.deps.limits.maxResultChars;
    const clipped = truncated ? text.slice(0, this.deps.limits.maxResultChars) : text;

    if (guardrails.screenSources([{ text: clipped }]).kept.length === 0) {
      return { content: '', withheld: true, truncated, redacted: false };
    }
    const redactedText = guardrails.redactForOutput(clipped);
    return {
      content: redactedText,
      withheld: false,
      truncated,
      redacted: redactedText !== clipped,
    };
  }
}
