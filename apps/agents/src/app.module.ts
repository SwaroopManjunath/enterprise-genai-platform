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
import { HttpJsonClient } from '@genai/shared';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { GatewayClient, McpGatewayClient, RetrievalClient } from './clients/service-clients';
import { AGENTS_CONFIG, loadConfig, type AgentsConfig } from './config/config';
import { HealthController } from './health.controller';
import { AGENT_MODEL, GatewayAgentModel, type AgentModel } from './model/agent-model';
import { AgentRunner } from './runner/agent-runner';
import { RunsController } from './runs/runs.controller';
import { RunsExceptionFilter } from './runs/runs-exception.filter';
import { InMemoryRunStore, RUN_STORE, type RunStore } from './store/run-store';
import { builtinTools } from './tools/builtin-tools';
import {
  InMemoryMailer,
  InMemoryTicketSystem,
  MAILER,
  TICKET_SYSTEM,
  type Mailer,
  type TicketSystem,
} from './tools/fake-backends';
import { McpToolSource } from './tools/mcp-tool-source';
import {
  CompositeToolCatalog,
  TOOL_CATALOG,
  type ToolCatalog,
  type ToolSource,
} from './tools/tool-catalog';

const http = (service: string, url: string, timeoutMs: number): HttpJsonClient =>
  new HttpJsonClient({ service, baseUrl: url, timeoutMs });

@Module({
  controllers: [HealthController, RunsController],
  providers: [
    { provide: AGENTS_CONFIG, useFactory: () => loadConfig() },
    // Env-backed locally. In Azure, wire KeyVaultSecretProvider with a managed identity here.
    { provide: SECRET_PROVIDER, useFactory: () => new EnvSecretProvider() },
    {
      provide: OBO_CLIENT,
      inject: [AGENTS_CONFIG, SECRET_PROVIDER],
      useFactory: (c: AgentsConfig, secrets: SecretProvider) =>
        new EntraOboClient({
          tokenEndpoint: c.obo.tokenEndpoint,
          clientId: c.obo.clientId,
          clientSecretName: c.obo.clientSecretName,
          secrets,
        }),
    },
    {
      provide: RetrievalClient,
      inject: [AGENTS_CONFIG],
      useFactory: (c: AgentsConfig) =>
        new RetrievalClient(http('retrieval', c.retrieval.url, c.limits.toolTimeoutMs)),
    },
    {
      provide: GatewayClient,
      inject: [AGENTS_CONFIG],
      useFactory: (c: AgentsConfig) =>
        new GatewayClient(http('gateway', c.gateway.url, c.limits.modelTimeoutMs)),
    },
    {
      provide: Guardrails,
      inject: [AGENTS_CONFIG],
      useFactory: (c: AgentsConfig) =>
        new Guardrails({ mode: c.guardrails.mode, outputPii: c.guardrails.outputPii }),
    },
    // Development stand-ins; production swaps in Cosmos DB, the real ticketing system and mail.
    { provide: RUN_STORE, useFactory: () => new InMemoryRunStore() },
    { provide: TICKET_SYSTEM, useFactory: () => new InMemoryTicketSystem() },
    { provide: MAILER, useFactory: () => new InMemoryMailer() },
    {
      provide: TOOL_CATALOG,
      inject: [AGENTS_CONFIG, RetrievalClient, TICKET_SYSTEM, MAILER, OBO_CLIENT, Guardrails],
      useFactory: (
        c: AgentsConfig,
        retrieval: RetrievalClient,
        tickets: TicketSystem,
        mailer: Mailer,
        obo: OboTokenClient,
        guardrails: Guardrails,
      ) => {
        const builtin = builtinTools({
          retrieval,
          retrievalScope: c.retrieval.scope,
          tickets,
          mailer,
          emailAllowedDomains: c.emailAllowedDomains,
        });
        const sources: ToolSource[] = c.mcp
          ? [
              new McpToolSource(
                new McpGatewayClient(http('mcp-gateway', c.mcp.url, c.limits.toolTimeoutMs)),
                obo,
                c.mcp.scope,
                guardrails,
              ),
            ]
          : [];
        return new CompositeToolCatalog(builtin, sources);
      },
    },
    {
      provide: AGENT_MODEL,
      inject: [GatewayClient],
      useFactory: (gateway: GatewayClient) => new GatewayAgentModel(gateway),
    },
    {
      provide: AgentRunner,
      inject: [RUN_STORE, AGENT_MODEL, TOOL_CATALOG, Guardrails, OBO_CLIENT, AGENTS_CONFIG],
      useFactory: (
        store: RunStore,
        model: AgentModel,
        tools: ToolCatalog,
        guardrails: Guardrails,
        obo: OboTokenClient,
        c: AgentsConfig,
      ) =>
        new AgentRunner({
          store,
          model,
          tools,
          guardrails,
          obo,
          gatewayScope: c.gateway.scope,
          limits: c.limits,
        }),
    },
    { provide: APP_FILTER, useClass: RunsExceptionFilter },
    ...authProviders(),
  ],
})
export class AppModule {}
