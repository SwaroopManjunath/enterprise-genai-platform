import { randomUUID } from 'node:crypto';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
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
