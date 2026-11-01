import type { AuthenticatedPrincipal } from '@genai/auth';
import type { Guardrails } from '@genai/guardrails';
import {
  EgressBlockedError,
  LimitExceededError,
  ReviewMismatchError,
  ServerConflictError,
  ServerNotFoundError,
  ToolNotAvailableError,
  ToolQuarantinedError,
  UpstreamError,
} from '../domain/errors';
import type { McpServer, ServerAuth, ToolPolicy, ToolRecord, ToolRisk } from '../domain/types';
import type { HostPolicy } from '../egress/host-policy';
import type { McpClient, RawTool } from '../mcp/mcp-client';
import type { SchemaValidator } from '../mcp/schema-validator';
import type { RegistryStore } from '../store/stores';
import type { AuditLog } from './audit-log';
import { classifyTool } from './classify';
import type { UpstreamAuth } from './upstream-auth';

export interface RegistryLimits {
  maxServersPerTenant: number;
  maxToolsPerServer: number;
  maxDescriptionChars: number;
  maxSchemaChars: number;
}

export interface RegistryDeps {
  store: RegistryStore;
  audit: AuditLog;
  client: McpClient;
  auth: UpstreamAuth;
  policy: HostPolicy;
  guardrails: Guardrails;
  validator: SchemaValidator;
  limits: RegistryLimits;
  now: () => number;
}

export interface RefreshChanges {
  added: string[];
  changed: string[];
  removed: string[];
  quarantined: string[];
}

export interface PolicyInput {
  /** The hash the admin reviewed. Approval only applies if the tool still has exactly this hash. */
  reviewedHash: string;
  enabled: boolean;
  allowedRoles: string[];
  risk: ToolRisk;
}

/**
 * The register of MCP servers a tenant has approved, and what each of their tools may do.
 *
 * Nothing is callable by default: a discovered tool is `pending`, and becomes usable only when an
 * admin approves a specific definition. The approval pins that definition's hash, and any later
 * change switches the tool off until it is reviewed again, so a server cannot swap in different
 * behaviour after it was vetted (a "rug pull").
 */
export class RegistryService {
  constructor(private readonly deps: RegistryDeps) {}

  async register(
    actor: AuthenticatedPrincipal,
    input: { id: string; name: string; url: string; auth: ServerAuth },
    requestId: string,
  ): Promise<McpServer> {
    const { store, limits } = this.deps;
    this.deps.policy.check(input.url); // refuse a bad URL before touching the network

    if (await store.get(actor.tenantId, input.id)) throw new ServerConflictError(input.id);
    if ((await store.list(actor.tenantId)).length >= limits.maxServersPerTenant) {
      throw new LimitExceededError(`At most ${limits.maxServersPerTenant} servers per tenant`);
    }

    let raw: RawTool[];
    try {
      raw = await this.readTools(input.url, input.auth, actor);
    } catch (error) {
      await this.auditFailure(actor, 'server_registered', input.id, error, requestId);
      throw error;
    }

    const now = this.deps.now();
    const server: McpServer = {
      id: input.id,
      tenantId: actor.tenantId,
      name: input.name,
      url: input.url,
      auth: input.auth,
      enabled: true,
      tools: raw.map((tool) => this.record(tool, undefined)),
      createdBy: actor.userId,
      createdAt: new Date(now).toISOString(),
      lastVerifiedAt: now,
      revision: 0,
    };
    const saved = await store.save(server);
    await this.deps.audit.record({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'server_registered',
      outcome: 'ok',
      server: input.id,
      reason: `${raw.length} tools discovered, none approved`,
      requestId,
    });
    return saved;
  }

  list(actor: AuthenticatedPrincipal): Promise<McpServer[]> {
    return this.deps.store.list(actor.tenantId);
  }

  async get(actor: AuthenticatedPrincipal, serverId: string): Promise<McpServer> {
    const server = await this.deps.store.get(actor.tenantId, serverId);
    if (!server) throw new ServerNotFoundError(serverId);
    return server;
  }

  /** Re-reads the tool list and reconciles it with what was reviewed. */
  async refresh(
    actor: AuthenticatedPrincipal,
    serverId: string,
    requestId: string,
  ): Promise<{ server: McpServer; changes: RefreshChanges }> {
    const server = await this.get(actor, serverId);
    const bearer = await this.deps.auth.bearerFor(server.auth, actor);
    return this.reconcile(server, actor, bearer, requestId);
  }

  /**
   * The same reconciliation, run by the gateway itself while serving a call, so a changed
   * definition is caught as soon as the cached list is older than the verify interval.
   */
  async reconcile(
    server: McpServer,
    actor: AuthenticatedPrincipal,
    bearer: string | undefined,
    requestId: string,
  ): Promise<{ server: McpServer; changes: RefreshChanges }> {
    let raw: RawTool[];
    try {
      raw = await this.deps.client.listTools({ url: server.url, ...(bearer && { bearer }) });
      this.assertToolCount(raw);
    } catch (error) {
      await this.auditFailure(actor, 'server_refreshed', server.id, error, requestId);
      throw error;
    }

    const changes: RefreshChanges = { added: [], changed: [], removed: [], quarantined: [] };
    const previous = new Map(server.tools.map((t) => [t.name, t]));
    const seen = new Set<string>();
    const tools: ToolRecord[] = [];

    for (const tool of raw) {
      const before = previous.get(tool.name.slice(0, 64));
      const next = this.record(tool, before);
      seen.add(next.name);
      if (!before) changes.added.push(next.name);
      else if (before.hash !== next.hash) changes.changed.push(next.name);
      if (next.status === 'quarantined') changes.quarantined.push(next.name);
      tools.push(next);
    }
    for (const before of server.tools) {
      if (seen.has(before.name)) continue;
      if (before.status !== 'removed') changes.removed.push(before.name);
      tools.push({ ...before, status: 'removed' });
    }

    const saved = await this.deps.store.save({
      ...server,
      tools,
      lastVerifiedAt: this.deps.now(),
    });
    const parts = (Object.entries(changes) as [string, string[]][])
      .filter(([, names]) => names.length > 0)
      .map(([kind, names]) => `${kind}=${names.join('|')}`);
    await this.deps.audit.record({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'server_refreshed',
      outcome: 'ok',
      server: server.id,
      reason: parts.length ? parts.join(' ') : 'no changes',
      requestId,
    });
    return { server: saved, changes };
  }

  /** Approves one specific definition for the given roles, or switches the tool off. */
  async setPolicy(
    actor: AuthenticatedPrincipal,
    serverId: string,
    toolName: string,
    input: PolicyInput,
    requestId: string,
  ): Promise<McpServer> {
    const server = await this.get(actor, serverId);
    const tool = server.tools.find((t) => t.name === toolName);
    if (!tool || tool.status === 'removed') throw new ToolNotAvailableError('unknown_tool');
    if (tool.status === 'quarantined') {
      throw new ToolQuarantinedError(tool.quarantineReasons ?? []);
    }
    if (input.reviewedHash !== tool.hash) throw new ReviewMismatchError();

    const policy: ToolPolicy = {
      enabled: input.enabled,
      allowedRoles: [...new Set(input.allowedRoles.map((r) => r.toLowerCase()))].sort(),
      risk: input.risk,
      approvedBy: actor.userId,
      approvedAt: new Date(this.deps.now()).toISOString(),
      pinnedHash: tool.hash,
    };
    const saved = await this.deps.store.save({
      ...server,
      tools: server.tools.map((t) =>
        t.name === toolName ? { ...t, status: 'approved', policy } : t,
      ),
    });
    await this.deps.audit.record({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'policy_changed',
      outcome: 'ok',
      server: serverId,
      tool: toolName,
      reason: `enabled=${policy.enabled} risk=${policy.risk} roles=${policy.allowedRoles.join('|') || 'any'}`,
      requestId,
    });
    return saved;
  }

  /** The kill switch: a disabled server answers nothing, whatever its tools' policies say. */
  async setEnabled(
    actor: AuthenticatedPrincipal,
    serverId: string,
    enabled: boolean,
    requestId: string,
  ): Promise<McpServer> {
    const server = await this.get(actor, serverId);
    const saved = await this.deps.store.save({ ...server, enabled });
    await this.deps.audit.record({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'server_state_changed',
      outcome: 'ok',
      server: serverId,
      reason: enabled ? 'enabled' : 'disabled',
      requestId,
    });
    return saved;
  }

  async remove(actor: AuthenticatedPrincipal, serverId: string, requestId: string): Promise<void> {
    await this.get(actor, serverId);
    await this.deps.store.delete(actor.tenantId, serverId);
    await this.deps.audit.record({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'server_removed',
      outcome: 'ok',
      server: serverId,
      requestId,
    });
  }

  private async readTools(
    url: string,
    auth: ServerAuth,
    actor: AuthenticatedPrincipal,
  ): Promise<RawTool[]> {
    const bearer = await this.deps.auth.bearerFor(auth, actor);
    const raw = await this.deps.client.listTools({ url, ...(bearer && { bearer }) });
    this.assertToolCount(raw);
    return raw;
  }

  private assertToolCount(raw: RawTool[]): void {
    if (raw.length > this.deps.limits.maxToolsPerServer) {
      throw new LimitExceededError(
        `The server offers ${raw.length} tools; the limit is ${this.deps.limits.maxToolsPerServer}`,
      );
    }
  }

  /**
   * What a tool's status is, given what the server says now and what was approved before:
   * a hostile definition is quarantined; an approved one stays approved only while its hash is
   * unchanged; anything else waits for review.
   */
  private record(raw: RawTool, before: ToolRecord | undefined): ToolRecord {
    const { record, quarantineReasons } = classifyTool(raw, this.deps, this.deps.limits);
    const policy = before?.policy;

    if (quarantineReasons.length > 0) {
      return { ...record, status: 'quarantined', quarantineReasons, ...(policy && { policy }) };
    }
    if (policy) {
      return {
        ...record,
        status: policy.pinnedHash === record.hash ? 'approved' : 'changed',
        policy,
      };
    }
    return { ...record, status: 'pending' };
  }

  private async auditFailure(
    actor: AuthenticatedPrincipal,
    action: 'server_registered' | 'server_refreshed',
    serverId: string,
    error: unknown,
    requestId: string,
  ): Promise<void> {
    const reason =
      error instanceof UpstreamError
        ? `upstream_${error.kind}`
        : error instanceof EgressBlockedError
          ? 'egress_blocked'
          : error instanceof LimitExceededError
            ? 'limit_exceeded'
            : 'error';
    await this.deps.audit.record({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action,
      outcome: 'upstream_error',
      server: serverId,
      reason,
      requestId,
    });
  }
}
