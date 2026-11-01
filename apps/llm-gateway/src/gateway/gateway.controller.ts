import { CurrentPrincipal, type AuthenticatedPrincipal } from '@genai/auth';
import { createTenantContext, formatSse } from '@genai/shared';
import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProviderError } from '../llm/provider-error';
import { parseChatBody } from './chat-request.schema';
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
    @Res() res: Response,
  ): Promise<void> {
    // Identity comes only from the verified token. x-request-id is a correlation id for tracing,
    // not an identity claim, so honouring it is safe.
    const ctx = createTenantContext({
      tenantId: principal.tenantId,
      userId: principal.userId,
      roles: principal.roles,
      ...(requestId !== undefined && { requestId }),
    });
    const { request, stream } = parseChatBody(body);
    res.setHeader('x-request-id', ctx.requestId);

    if (!stream) {
      const result = await this.gateway.chat(ctx, request);
      res.json({
        requestId: ctx.requestId,
        provider: result.provider,
        fallbackUsed: result.fallbackUsed,
        message: result.message,
        finishReason: result.finishReason,
        usage: result.usage,
        cost: result.cost,
      });
      return;
    }

    await this.stream(ctx, request, res);
  }

  /**
   * Server-sent events: `delta` pieces of text, then one `done` with usage and cost. Everything that
   * can refuse the request (limits, budget, a deployment that is down) happens before the first
   * byte, so those still arrive as ordinary JSON errors with the usual status codes; only a failure
   * after the stream has begun is reported in-band, as an `error` event.
   */
  private async stream(
    ctx: ReturnType<typeof createTenantContext>,
    request: Parameters<GatewayService['chatStream']>[1],
    res: Response,
  ): Promise<void> {
    // A client that hangs up stops the upstream call too: the deployment stops generating, and billing.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const events = this.gateway.chatStream(ctx, request, abort.signal);
    try {
      const first = await events.next(); // refusals throw here, before anything is written
      res.status(200).set({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();

      let event = first;
      while (!event.done) {
        const { type, ...data } = event.value;
        if (!res.write(formatSse(type, data))) await new Promise((r) => res.once('drain', r));
        event = await events.next();
      }
    } catch (error) {
      if (!res.headersSent) throw error; // the exception filter turns it into a JSON error
      const code = error instanceof ProviderError ? 'upstream_error' : 'internal_error';
      res.write(formatSse('error', { code }));
    } finally {
      await events.return(undefined);
      // Before the first byte the exception filter still has to write the error response.
      if (res.headersSent) res.end();
    }
  }
}
