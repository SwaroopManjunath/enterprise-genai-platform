import { randomUUID } from 'node:crypto';
import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { formatSse } from '@genai/shared';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CacheStatsTracker } from '../cache/cache-stats';
import { AskService, type AskInput } from './ask.service';
import { askSchema } from './schemas';

@Controller('v1')
export class AskController {
  constructor(private readonly assistant: AskService) {}

  /**
   * Ask a question as the authenticated user. Which documents can answer it is decided by that
   * user's tenant and roles, not by anything in the request.
   *
   * With `stream: true` the answer arrives as server-sent events (`meta`, `delta`..., `done`).
   * Everything that can refuse the request happens before the first event, so those refusals are
   * ordinary JSON errors with the usual status codes; the `done` event carries the verified answer
   * and is the authoritative one.
   */
  @Post('ask')
  @HttpCode(200)
  async ask(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestIdHeader: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const { stream, ...input } = askSchema.parse(body);
    // A client-supplied id is a tracing aid only; one is generated when absent.
    const requestId =
      requestIdHeader && requestIdHeader.length <= 128 ? requestIdHeader : randomUUID();
    res.setHeader('x-request-id', requestId);

    if (!stream) {
      res.json(await this.assistant.ask(caller, input as AskInput, requestId));
      return;
    }
    await this.stream(caller, input as AskInput, requestId, res);
  }

  private async stream(
    caller: AuthenticatedPrincipal,
    input: AskInput,
    requestId: string,
    res: Response,
  ): Promise<void> {
    // A client that hangs up stops the model call too.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const events = this.assistant.askStream(caller, input, requestId, abort.signal);
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
        const value = event.value;
        const data =
          value.type === 'done'
            ? { replace: value.replace, ...value.result }
            : (({ type: _type, ...rest }) => rest)(value);
        if (!res.write(formatSse(value.type, data))) await new Promise((r) => res.once('drain', r));
        event = await events.next();
      }
    } catch (error) {
      if (!res.headersSent) throw error; // the exception filter turns it into a JSON error
      res.write(formatSse('error', { code: 'internal_error' }));
    } finally {
      await events.return(undefined);
      // Before the first byte the exception filter still has to write the error response.
      if (res.headersSent) res.end();
    }
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
