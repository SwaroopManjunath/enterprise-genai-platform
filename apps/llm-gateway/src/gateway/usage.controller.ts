import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { COST_TRACKER, type CostTracker } from '../cost/cost-tracker';
import { microToUsd } from '../cost/pricing';
import { DAILY_BUDGET } from './gateway.service';

export const COST_VIEWER_ROLE = 'cost-viewer';

const querySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

/** What a tenant has spent. Only people with the cost-viewer role may see it, and only their own tenant's. */
@Controller('v1')
@RequireRoles(COST_VIEWER_ROLE)
export class UsageController {
  constructor(
    @Inject(COST_TRACKER) private readonly costs: CostTracker,
    @Inject(DAILY_BUDGET) private readonly dailyBudgetMicroUsd: number | undefined,
  ) {}

  @Get('usage')
  usage(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Query() query: unknown) {
    const { days } = querySchema.parse(query);
    const spent = this.costs.todayMicroUsd(caller.tenantId);
    return {
      tenantId: caller.tenantId,
      today: {
        spentUsd: microToUsd(spent),
        ...(this.dailyBudgetMicroUsd !== undefined && {
          budgetUsd: microToUsd(this.dailyBudgetMicroUsd),
          remainingUsd: microToUsd(Math.max(0, this.dailyBudgetMicroUsd - spent)),
        }),
      },
      days: this.costs.summary(caller.tenantId, days).map((d) => ({
        ...d,
        costUsd: microToUsd(d.costMicroUsd),
        byProvider: Object.fromEntries(
          Object.entries(d.byProvider).map(([name, p]) => [
            name,
            { ...p, costUsd: microToUsd(p.costMicroUsd) },
          ]),
        ),
      })),
    };
  }
}
