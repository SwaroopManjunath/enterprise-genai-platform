import { randomUUID } from 'node:crypto';
import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CacheStatsTracker } from '../cache/cache-stats';
import { AskService } from './ask.service';
import { askSchema } from './schemas';

@Controller('v1')
export class AskController {
  constructor(private readonly assistant: AskService) {}

  /**
   * Ask a question as the authenticated user. Which documents can answer it is decided by that
   * user's tenant and roles, not by anything in the request.
   */
  @Post('ask')
  @HttpCode(200)
  async ask(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestIdHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = askSchema.parse(body);
    // A client-supplied id is a tracing aid only; one is generated when absent.
    const requestId =
      requestIdHeader && requestIdHeader.length <= 128 ? requestIdHeader : randomUUID();

    const result = await this.assistant.ask(caller, input, requestId);

    res.setHeader('x-request-id', requestId);
    return result;
  }
}

export const COST_VIEWER_ROLE = 'cost-viewer';

/** How well the answer cache is working for the caller's tenant, and what it has saved. */
@Controller('v1')
@RequireRoles(COST_VIEWER_ROLE)
export class CacheController {
  constructor(@Inject(CacheStatsTracker) private readonly stats: CacheStatsTracker) {}

  @Get('cache/stats')
  statsFor(@CurrentPrincipal() caller: AuthenticatedPrincipal) {
    const stats = this.stats.get(caller.tenantId);
    return {
      tenantId: caller.tenantId,
      ...stats,
      savedUsd: stats.savedMicroUsd / 1_000_000,
      shadow: {
        ...stats.shadow,
        potentialSavedUsd: stats.shadow.potentialSavedMicroUsd / 1_000_000,
      },
    };
  }
}
