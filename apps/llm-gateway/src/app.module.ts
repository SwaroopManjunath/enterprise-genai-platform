import { Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { loadConfig, type GatewayConfig } from './config/config';
import { GatewayController } from './gateway/gateway.controller';
import { GatewayExceptionFilter } from './gateway/gateway-exception.filter';
import { GatewayService } from './gateway/gateway.service';
import { HealthController } from './health.controller';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from './limits/rate-limiter';
import { InMemoryTokenQuota, TOKEN_QUOTA } from './limits/token-quota';
import { AzureOpenAiProvider } from './llm/azure-openai.provider';
import { MockProvider } from './llm/mock.provider';
import { LLM_PROVIDERS, type LlmProvider } from './llm/types';
import { LlmRouter } from './resilience/llm-router';

export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

function buildProviders(config: GatewayConfig): LlmProvider[] {
  if (config.provider === 'mock') return [new MockProvider()];
  return config.deployments.map((d) => new AzureOpenAiProvider(d, config.upstreamTimeoutMs));
}

@Module({
  controllers: [HealthController, GatewayController],
  providers: [
    { provide: GATEWAY_CONFIG, useFactory: () => loadConfig() },
    { provide: LLM_PROVIDERS, inject: [GATEWAY_CONFIG], useFactory: buildProviders },
    {
      provide: RATE_LIMITER,
      inject: [GATEWAY_CONFIG],
      useFactory: (c: GatewayConfig) =>
        new InMemoryTokenBucketRateLimiter(c.limits.requestsPerMinute),
    },
    {
      provide: TOKEN_QUOTA,
      inject: [GATEWAY_CONFIG],
      useFactory: (c: GatewayConfig) => new InMemoryTokenQuota(c.limits.dailyTokenQuota),
    },
    {
      provide: LlmRouter,
      inject: [GATEWAY_CONFIG, LLM_PROVIDERS],
      useFactory: (c: GatewayConfig, providers: LlmProvider[]) => {
        const logger = new Logger('LlmRouter');
        return new LlmRouter(providers, c.retry, (e) =>
          logger.warn(`deployment failed: ${e.message}`),
        );
      },
    },
    GatewayService,
    { provide: APP_FILTER, useClass: GatewayExceptionFilter },
  ],
})
export class AppModule {}
