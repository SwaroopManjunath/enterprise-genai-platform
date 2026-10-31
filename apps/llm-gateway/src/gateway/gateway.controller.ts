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
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Interim identity: the tenant comes from a header. Step 6 replaces this with a validated
    // Entra ID JWT so a caller can no longer claim an arbitrary tenant.
    const ctx = createTenantContext({
      tenantId: tenantId ?? '',
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
