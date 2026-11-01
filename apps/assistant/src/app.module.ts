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
import { ANSWER_CACHE, InMemoryAnswerCache, type AnswerCache } from './cache/answer-cache';
import { CacheLayer } from './cache/cache-layer';
import { CacheStatsTracker } from './cache/cache-stats';
import { HttpJsonClient } from '@genai/shared';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AskController, CacheController } from './ask/ask.controller';
import { AskExceptionFilter } from './ask/ask-exception.filter';
import { AskService } from './ask/ask.service';
import { GatewayClient, PromptClient, RetrievalClient } from './clients/service-clients';
import { ASSISTANT_CONFIG, loadConfig, type AssistantConfig } from './config/config';
import { HealthController } from './health.controller';

const http = (service: string, url: string, c: AssistantConfig): HttpJsonClient =>
  new HttpJsonClient({ service, baseUrl: url, timeoutMs: c.downstreamTimeoutMs });

@Module({
  imports: [TelemetryModule.forService('assistant')],
  controllers: [HealthController, AskController, CacheController],
  providers: [
    { provide: ASSISTANT_CONFIG, useFactory: () => loadConfig() },
    // Env-backed locally. In Azure, wire KeyVaultSecretProvider with a managed identity here.
    { provide: SECRET_PROVIDER, useFactory: () => new EnvSecretProvider() },
    {
      provide: OBO_CLIENT,
      inject: [ASSISTANT_CONFIG, SECRET_PROVIDER],
      useFactory: (c: AssistantConfig, secrets: SecretProvider) =>
        new EntraOboClient({
          tokenEndpoint: c.obo.tokenEndpoint,
          clientId: c.obo.clientId,
          clientSecretName: c.obo.clientSecretName,
          secrets,
        }),
    },
    {
      provide: RetrievalClient,
      inject: [ASSISTANT_CONFIG],
      useFactory: (c: AssistantConfig) =>
        new RetrievalClient(http('retrieval', c.retrieval.url, c)),
    },
    {
      provide: PromptClient,
      inject: [ASSISTANT_CONFIG],
      useFactory: (c: AssistantConfig) =>
        new PromptClient(http('prompt-registry', c.prompts.url, c)),
    },
    {
      provide: GatewayClient,
      inject: [ASSISTANT_CONFIG],
      useFactory: (c: AssistantConfig) => new GatewayClient(http('gateway', c.gateway.url, c)),
    },
    {
      provide: Guardrails,
      inject: [ASSISTANT_CONFIG],
      useFactory: (c: AssistantConfig) =>
        new Guardrails({ mode: c.guardrails.mode, outputPii: c.guardrails.outputPii }),
    },
    { provide: CacheStatsTracker, useFactory: () => new CacheStatsTracker() },
    {
      provide: ANSWER_CACHE,
      inject: [ASSISTANT_CONFIG],
      useFactory: (c: AssistantConfig) =>
        new InMemoryAnswerCache({
          ttlMs: c.cache.ttlMs,
          maxEntriesPerTenant: c.cache.maxEntriesPerTenant,
          similarity: c.cache.similarity,
        }),
    },
    {
      provide: CacheLayer,
      inject: [ASSISTANT_CONFIG, ANSWER_CACHE, CacheStatsTracker],
      useFactory: (c: AssistantConfig, cache: AnswerCache, stats: CacheStatsTracker) =>
        new CacheLayer(c.cache.mode, cache, stats, c.cache.epoch),
    },
    {
      provide: AskService,
      inject: [
        RetrievalClient,
        PromptClient,
        GatewayClient,
        OBO_CLIENT,
        ASSISTANT_CONFIG,
        Guardrails,
        CacheLayer,
      ],
      useFactory: (
        retrieval: RetrievalClient,
        prompts: PromptClient,
        gateway: GatewayClient,
        obo: OboTokenClient,
        config: AssistantConfig,
        guardrails: Guardrails,
        cache: CacheLayer,
      ) => new AskService({ retrieval, prompts, gateway, obo }, config, guardrails, cache),
    },
    { provide: APP_FILTER, useClass: AskExceptionFilter },
    ...authProviders(),
  ],
})
export class AppModule {}
