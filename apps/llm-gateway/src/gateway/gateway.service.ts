import { Inject, Injectable } from '@nestjs/common';
import type { TenantContext } from '@genai/shared';
import { RATE_LIMITER, type RateLimiter } from '../limits/rate-limiter';
import { TOKEN_QUOTA, type TokenQuota } from '../limits/token-quota';
import type { ChatRequest } from '../llm/types';
import { LlmRouter, type RoutedChatResult } from '../resilience/llm-router';
import { QuotaExceededError, RateLimitedError } from './errors';

@Injectable()
export class GatewayService {
  constructor(
    private readonly router: LlmRouter,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(TOKEN_QUOTA) private readonly quota: TokenQuota,
  ) {}

  /**
   * Order matters: the cheap local checks run first so a throttled or over-budget tenant never
   * reaches (or pays for) an upstream call.
   */
  async chat(ctx: TenantContext, request: ChatRequest): Promise<RoutedChatResult> {
    const decision = this.rateLimiter.tryConsume(ctx.tenantId);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterMs);

    const quota = this.quota.status(ctx.tenantId);
    if (quota.remaining <= 0) throw new QuotaExceededError(quota.limit, quota.used);

    const result = await this.router.chat(request);
    this.quota.record(ctx.tenantId, result.usage.totalTokens);
    return result;
  }
}
