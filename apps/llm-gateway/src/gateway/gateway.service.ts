import { Inject, Injectable } from '@nestjs/common';
import type { TenantContext } from '@genai/shared';
import { RATE_LIMITER, type RateLimiter } from '../limits/rate-limiter';
import { TOKEN_QUOTA, type TokenQuota } from '../limits/token-quota';
import type { ChatRequest } from '../llm/types';
import { estimateTokens } from '../llm/tokens';
import type { Usage } from '../llm/types';
import { LlmRouter, type RoutedChatResult } from '../resilience/llm-router';
import { COST_TRACKER, type CostTracker } from '../cost/cost-tracker';
import { PRICE_BOOK, type Cost, type PriceBook } from '../cost/pricing';
import { BudgetExceededError, QuotaExceededError, RateLimitedError } from './errors';

/** What a streaming caller receives: text pieces, then the closing facts with the cost. */
export type GatewayStreamEvent =
  | { type: 'delta'; text: string; provider: string; fallbackUsed: boolean }
  | {
      type: 'done';
      finishReason: string;
      usage: Usage;
      provider: string;
      fallbackUsed: boolean;
      cost: Cost;
      estimated: boolean;
    };

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

  /**
   * Streams an answer. The same admission checks run first, so a throttled or over-budget tenant
   * never opens an upstream stream. The call is billed when the stream ends: with the upstream's own
   * token counts when it sends them, and otherwise (a client that hung up, a stream that broke)
   * with an estimate marked as such, so an interrupted answer, which the deployment still charged
   * for, does not vanish from the tenant's spend.
   */
  async *chatStream(
    ctx: TenantContext,
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<GatewayStreamEvent, void, void> {
    this.admit(ctx);

    let provider: string | undefined;
    let streamed = '';
    let settled = false;
    try {
      for await (const event of this.router.chatStream(request, signal)) {
        provider = event.provider;
        if (event.type === 'delta') {
          streamed += event.text;
          yield event;
          continue;
        }
        const reported = event.usage.totalTokens > 0;
        const usage = reported ? event.usage : this.estimateUsage(request, streamed);
        const cost = this.settle(ctx, { provider: event.provider, usage }, true, !reported);
        settled = true;
        yield { ...event, usage, cost, estimated: !reported };
      }
    } finally {
      if (!settled && provider !== undefined && streamed.length > 0) {
        this.settle(ctx, { provider, usage: this.estimateUsage(request, streamed) }, true, true);
      }
    }
  }

  private estimateUsage(request: ChatRequest, streamed: string): Usage {
    const promptTokens = estimateTokens(request.messages.map((m) => m.content).join(' '));
    const completionTokens = estimateTokens(streamed);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
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
    estimated = false,
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
      estimated,
    });
    return cost;
  }
}
