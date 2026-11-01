import { TelemetryModule } from '@genai/observability';
import {
  EntraOboClient,
  EnvSecretProvider,
  OBO_CLIENT,
  SECRET_PROVIDER,
  authProviders,
  type OboTokenClient,
  type SecretProvider,
} from '@genai/auth';
import { Guardrails } from '@genai/guardrails';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { McpExceptionFilter } from './api/mcp-exception.filter';
import { AuditController, ServersController, ToolsController } from './api/mcp.controller';
import { MCP_GATEWAY_CONFIG, loadConfig, type McpGatewayConfig } from './config/config';
import { GuardedTransport, TRANSPORT, type Transport } from './egress/guarded-transport';
import { HostPolicy } from './egress/host-policy';
import { HealthController } from './health.controller';
import { RateLimiter } from './invoke/rate-limiter';
import { ToolInvoker } from './invoke/tool-invoker';
import { McpClient } from './mcp/mcp-client';
import { SchemaValidator } from './mcp/schema-validator';
import { AuditLog } from './registry/audit-log';
import { RegistryService } from './registry/registry-service';
import { UpstreamAuth } from './registry/upstream-auth';
import {
  AUDIT_STORE,
  InMemoryAuditStore,
  InMemoryRegistryStore,
  REGISTRY_STORE,
  type AuditStore,
  type RegistryStore,
} from './store/stores';

@Module({
  imports: [TelemetryModule.forService('mcp-gateway')],
  controllers: [HealthController, ServersController, ToolsController, AuditController],
  providers: [
    { provide: MCP_GATEWAY_CONFIG, useFactory: () => loadConfig() },
    // Env-backed locally. In Azure, wire KeyVaultSecretProvider with a managed identity here.
    { provide: SECRET_PROVIDER, useFactory: () => new EnvSecretProvider() },
    {
      provide: OBO_CLIENT,
      inject: [MCP_GATEWAY_CONFIG, SECRET_PROVIDER],
      useFactory: (c: McpGatewayConfig, secrets: SecretProvider) =>
        new EntraOboClient({
          tokenEndpoint: c.obo.tokenEndpoint,
          clientId: c.obo.clientId,
          clientSecretName: c.obo.clientSecretName,
          secrets,
        }),
    },
    {
      provide: HostPolicy,
      inject: [MCP_GATEWAY_CONFIG],
      useFactory: (c: McpGatewayConfig) => new HostPolicy(c.allowedHosts),
    },
    {
      provide: TRANSPORT,
      inject: [HostPolicy],
      useFactory: (policy: HostPolicy) => new GuardedTransport(policy),
    },
    {
      provide: McpClient,
      inject: [TRANSPORT, MCP_GATEWAY_CONFIG],
      useFactory: (transport: Transport, c: McpGatewayConfig) =>
        new McpClient(transport, { timeoutMs: c.upstreamTimeoutMs, maxBytes: c.maxUpstreamBytes }),
    },
    { provide: SchemaValidator, useFactory: () => new SchemaValidator() },
    {
      provide: Guardrails,
      inject: [MCP_GATEWAY_CONFIG],
      useFactory: (c: McpGatewayConfig) =>
        new Guardrails({ mode: c.guardrails.mode, outputPii: c.guardrails.outputPii }),
    },
    // Development stand-ins; production swaps in Cosmos DB, partitioned by tenant.
    { provide: REGISTRY_STORE, useFactory: () => new InMemoryRegistryStore() },
    { provide: AUDIT_STORE, useFactory: () => new InMemoryAuditStore() },
    {
      provide: AuditLog,
      inject: [AUDIT_STORE],
      useFactory: (store: AuditStore) => new AuditLog(store, Date.now),
    },
    {
      provide: UpstreamAuth,
      inject: [OBO_CLIENT, SECRET_PROVIDER],
      useFactory: (obo: OboTokenClient, secrets: SecretProvider) => new UpstreamAuth(obo, secrets),
    },
    {
      provide: RegistryService,
      inject: [
        REGISTRY_STORE,
        AuditLog,
        McpClient,
        UpstreamAuth,
        HostPolicy,
        Guardrails,
        SchemaValidator,
        MCP_GATEWAY_CONFIG,
      ],
      useFactory: (
        store: RegistryStore,
        audit: AuditLog,
        client: McpClient,
        auth: UpstreamAuth,
        policy: HostPolicy,
        guardrails: Guardrails,
        validator: SchemaValidator,
        c: McpGatewayConfig,
      ) =>
        new RegistryService({
          store,
          audit,
          client,
          auth,
          policy,
          guardrails,
          validator,
          limits: {
            maxServersPerTenant: c.maxServersPerTenant,
            maxToolsPerServer: c.maxToolsPerServer,
            maxDescriptionChars: c.maxDescriptionChars,
            maxSchemaChars: c.maxSchemaChars,
          },
          now: Date.now,
        }),
    },
    {
      provide: RateLimiter,
      inject: [MCP_GATEWAY_CONFIG],
      useFactory: (c: McpGatewayConfig) => new RateLimiter(c.rateLimitPerMinute, Date.now),
    },
    {
      provide: ToolInvoker,
      inject: [
        REGISTRY_STORE,
        RegistryService,
        AuditLog,
        McpClient,
        UpstreamAuth,
        SchemaValidator,
        Guardrails,
        RateLimiter,
        MCP_GATEWAY_CONFIG,
      ],
      useFactory: (
        store: RegistryStore,
        registry: RegistryService,
        audit: AuditLog,
        client: McpClient,
        auth: UpstreamAuth,
        validator: SchemaValidator,
        guardrails: Guardrails,
        limiter: RateLimiter,
        c: McpGatewayConfig,
      ) =>
        new ToolInvoker({
          store,
          registry,
          audit,
          client,
          auth,
          validator,
          guardrails,
          limiter,
          limits: { verifyTtlMs: c.verifyTtlMs, maxResultChars: c.maxResultChars },
          now: Date.now,
        }),
    },
    { provide: APP_FILTER, useClass: McpExceptionFilter },
    ...authProviders(),
  ],
})
export class AppModule {}
