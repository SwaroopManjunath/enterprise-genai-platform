import type { AuthenticatedPrincipal } from '@genai/auth';
import { Guardrails } from '@genai/guardrails';
import type { McpGatewayConfig } from '../config/config';
import { GuardedTransport } from '../egress/guarded-transport';
import { HostPolicy } from '../egress/host-policy';
import { McpClient } from '../mcp/mcp-client';
import { SchemaValidator } from '../mcp/schema-validator';
import { AuditLog } from '../registry/audit-log';
import { RegistryService } from '../registry/registry-service';
import { UpstreamAuth } from '../registry/upstream-auth';
import { InMemoryAuditStore, InMemoryRegistryStore } from '../store/stores';

export const principal = (
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal => ({
  tenantId: 'acme',
  userId: 'admin-1',
  roles: ['mcp-admin', 'mcp-user'],
  scopes: [],
  tokenId: undefined,
  expiresAt: new Date(Date.now() + 3_600_000),
  accessToken: 'admin-token',
  ...overrides,
});

export const LIMITS = {
  maxServersPerTenant: 3,
  maxToolsPerServer: 10,
  maxDescriptionChars: 100,
  maxSchemaChars: 2_000,
};

export const clock = { now: 1_000_000 };

export interface Kit {
  registry: RegistryService;
  store: InMemoryRegistryStore;
  auditStore: InMemoryAuditStore;
  audit: AuditLog;
  client: McpClient;
  guardrails: Guardrails;
  validator: SchemaValidator;
  policy: HostPolicy;
  obo: { exchange: jest.Mock };
  secrets: { get: jest.Mock };
  upstreamAuth: UpstreamAuth;
  config: Pick<McpGatewayConfig, 'upstreamTimeoutMs' | 'maxUpstreamBytes'>;
}

export function buildKit(
  options: { guardrails?: Guardrails; limits?: Partial<typeof LIMITS> } = {},
): Kit {
  const store = new InMemoryRegistryStore();
  const auditStore = new InMemoryAuditStore();
  const audit = new AuditLog(auditStore, () => clock.now);
  const policy = new HostPolicy(['127.0.0.1']);
  const config = { upstreamTimeoutMs: 2_000, maxUpstreamBytes: 100_000 };
  const client = new McpClient(new GuardedTransport(policy), {
    timeoutMs: config.upstreamTimeoutMs,
    maxBytes: config.maxUpstreamBytes,
  });
  const obo = {
    exchange: jest.fn((_token: string, scope: string) => Promise.resolve(`obo:${scope}`)),
  };
  const secrets = { get: jest.fn((name: string) => Promise.resolve(`secret:${name}`)) };
  const upstreamAuth = new UpstreamAuth(obo, secrets);
  const guardrails = options.guardrails ?? new Guardrails({ mode: 'enforce' });
  const validator = new SchemaValidator();
  const registry = new RegistryService({
    store,
    audit,
    client,
    auth: upstreamAuth,
    policy,
    guardrails,
    validator,
    limits: { ...LIMITS, ...options.limits },
    now: () => clock.now,
  });
  return {
    registry,
    store,
    auditStore,
    audit,
    client,
    guardrails,
    validator,
    policy,
    obo,
    secrets,
    upstreamAuth,
    config,
  };
}

import { RateLimiter } from '../invoke/rate-limiter';
import { ToolInvoker } from '../invoke/tool-invoker';

export function buildInvoker(
  kit: Kit,
  options: { verifyTtlMs?: number; maxResultChars?: number; ratePerMinute?: number } = {},
): ToolInvoker {
  return new ToolInvoker({
    store: kit.store,
    registry: kit.registry,
    audit: kit.audit,
    client: kit.client,
    auth: kit.upstreamAuth,
    validator: kit.validator,
    guardrails: kit.guardrails,
    limiter: new RateLimiter(options.ratePerMinute ?? 100, () => clock.now),
    limits: {
      verifyTtlMs: options.verifyTtlMs ?? 60_000,
      maxResultChars: options.maxResultChars ?? 500,
    },
    now: () => clock.now,
  });
}
