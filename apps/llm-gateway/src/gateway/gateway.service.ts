import { Inject, Injectable } from '@nestjs/common';
import type { TenantContext } from '@genai/shared';
import { RATE_LIMITER, type RateLimiter } from '../limits/rate-limiter';
import { TOKEN_QUOTA, type TokenQuota } from '../limits/token-quota';
import type { ChatRequest } from '../llm/types';
import { LlmRouter, type RoutedChatResult } from '../resilience/llm-router';
import { COST_TRACKER, type CostTracker } from '../cost/cost-tracker';
import { PRICE_BOOK, type Cost, type PriceBook } from '../cost/pricing';
import { BudgetExceededError, QuotaExceededError, RateLimitedError } from './errors';

export const DAILY_BUDGET = Symbol('DAILY_BUDGET');

@Injectable()
export class GatewayService {
  constructor(
    private readonly router: LlmRouter,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(TOKEN_QUOTA) private readonly quota: TokenQuota,
    @Inject(PRICE_BOOK) private readonly prices: PriceBook,
    @Inject(COST_TRACKER) private readonly costs: CostTracker,
    @Inject(DAILY_BUDGET) private readonly dailyBudgetMicroUsd: number | undefined,
  ) {}

  /**
   * Order matters: the cheap local checks run first so a throttled or over-budget tenant never
   * reaches (or pays for) an upstream call.
   */
  async chat(ctx: TenantContext, request: ChatRequest): Promise<RoutedChatResult & { cost: Cost }> {
    this.admit(ctx);

    const result = await this.router.chat(request);
    const cost = this.settle(ctx, result, false);
    return { ...result, cost };
  }

  /** The checks every call passes before anything is sent upstream. */
  private admit(ctx: TenantContext): void {
    const decision = this.rateLimiter.tryConsume(ctx.tenantId);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterMs);

    const quota = this.quota.status(ctx.tenantId);
    if (quota.remaining <= 0) throw new QuotaExceededError(quota.limit, quota.used);

    const spent = this.costs.todayMicroUsd(ctx.tenantId);
    if (this.dailyBudgetMicroUsd !== undefined && spent >= this.dailyBudgetMicroUsd) {
      throw new BudgetExceededError(this.dailyBudgetMicroUsd, spent);
    }
  }

  /** Records what a finished call used and cost, against the tenant's quota and spend. */
  private settle(
    ctx: TenantContext,
    result: Pick<RoutedChatResult, 'provider' | 'usage'>,
    streamed: boolean,
  ): Cost {
    const cost = this.prices.cost(result.provider, result.usage);
    this.quota.record(ctx.tenantId, result.usage.totalTokens);
    this.costs.record({
      tenantId: ctx.tenantId,
      provider: result.provider,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      cost,
      streamed,
    });
    return cost;
  }
}
