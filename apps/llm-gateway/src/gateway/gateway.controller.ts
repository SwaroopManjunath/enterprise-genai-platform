import { CurrentPrincipal, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { createTenantContext } from '@genai/shared';
import type { Response } from 'express';
import { parseChatRequest } from './chat-request.schema';
import { GatewayService } from './gateway.service';

@Controller('v1')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Post('chat/completions')
  @HttpCode(200)
  async chat(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Headers('x-request-id') requestId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Identity comes only from the verified token. x-request-id is a correlation id for tracing,
    // not an identity claim, so honouring it is safe.
    const ctx = createTenantContext({
      tenantId: principal.tenantId,
      userId: principal.userId,
      roles: principal.roles,
      ...(requestId !== undefined && { requestId }),
    });
    const request = parseChatRequest(body);

    const result = await this.gateway.chat(ctx, request);

    res.setHeader('x-request-id', ctx.requestId);
    return {
      requestId: ctx.requestId,
      provider: result.provider,
      fallbackUsed: result.fallbackUsed,
      message: result.message,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  }
}
