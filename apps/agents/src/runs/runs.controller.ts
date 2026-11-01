import { randomUUID } from 'node:crypto';
import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AgentRunner, AUDITOR_ROLE } from '../runner/agent-runner';
import { TOOL_CATALOG, type ToolCatalog } from '../tools/tool-catalog';
import { decisionSchema, startRunSchema } from './schemas';
import { toRunView } from './run-view';

export const USER_ROLE = 'agent-user';

const requestIdFrom = (header: string | undefined): string =>
  header && header.length <= 128 ? header : randomUUID();

@Controller('v1')
export class RunsController {
  constructor(
    private readonly runner: AgentRunner,
    @Inject(TOOL_CATALOG) private readonly tools: ToolCatalog,
  ) {}

  /** The tools this caller's roles allow: the same list the model is shown. */
  @Get('tools')
  @RequireRoles(USER_ROLE)
  async listTools(@CurrentPrincipal() caller: AuthenticatedPrincipal) {
    const registry = await this.tools.registryFor(caller);
    return {
      tools: registry.visibleTo(caller.roles).map((t) => ({
        name: t.name,
        description: t.description,
        risk: t.risk,
        needsApproval: t.risk === 'write',
      })),
    };
  }

  /**
   * Starts a run as the authenticated user and drives it until it finishes or reaches a write
   * action that needs that user's approval.
   */
  @Post('runs')
  @RequireRoles(USER_ROLE)
  async start(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestIdHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = startRunSchema.parse(body);
    const requestId = requestIdFrom(requestIdHeader);

    const run = await this.runner.start(caller, input, requestId);

    res.setHeader('x-request-id', requestId);
    return toRunView(run, caller.userId);
  }

  /** The run's owner, or an auditor in the same tenant. */
  @Get('runs/:id')
  @RequireRoles(USER_ROLE, AUDITOR_ROLE)
  async get(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Param('id') id: string) {
    return toRunView(await this.runner.get(caller, id), caller.userId);
  }

  /** Approve or reject the write action the run is waiting on. Owner only. */
  @Post('runs/:id/approvals')
  @HttpCode(200)
  @RequireRoles(USER_ROLE)
  async decide(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestIdHeader: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = decisionSchema.parse(body);
    const requestId = requestIdFrom(requestIdHeader);

    const run = await this.runner.decide(caller, id, input, requestId);

    res.setHeader('x-request-id', requestId);
    return toRunView(run, caller.userId);
  }
}
