import { randomUUID } from 'node:crypto';
import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ToolInvoker } from '../invoke/tool-invoker';
import { RegistryService } from '../registry/registry-service';
import { AUDIT_STORE, type AuditStore } from '../store/stores';
import { Inject } from '@nestjs/common';
import { auditQuerySchema, callSchema, policySchema, registerSchema, stateSchema } from './schemas';
import { toServerView } from './views';

export const ADMIN_ROLE = 'mcp-admin';
export const USER_ROLE = 'mcp-user';
export const AUDITOR_ROLE = 'mcp-auditor';

const requestIdFrom = (header: string | undefined): string =>
  header && header.length <= 128 ? header : randomUUID();

/** Registry administration: who may reach which server, and which tools may run. */
@Controller('v1/servers')
@RequireRoles(ADMIN_ROLE)
export class ServersController {
  constructor(private readonly registry: RegistryService) {}

  @Post()
  async register(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestId: string | undefined,
    @Body() body: unknown,
  ) {
    const input = registerSchema.parse(body);
    return toServerView(await this.registry.register(caller, input, requestIdFrom(requestId)));
  }

  @Get()
  async list(@CurrentPrincipal() caller: AuthenticatedPrincipal) {
    return { servers: (await this.registry.list(caller)).map(toServerView) };
  }

  @Get(':id')
  async get(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Param('id') id: string) {
    return toServerView(await this.registry.get(caller, id));
  }

  /** Re-reads the tools now. Anything that changed since it was approved is switched off. */
  @Post(':id/refresh')
  @HttpCode(200)
  async refresh(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestId: string | undefined,
    @Param('id') id: string,
  ) {
    const { server, changes } = await this.registry.refresh(caller, id, requestIdFrom(requestId));
    return { server: toServerView(server), changes };
  }

  /** Approve a reviewed definition for some roles, or switch the tool off. */
  @Put(':id/tools/:tool/policy')
  async setPolicy(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestId: string | undefined,
    @Param('id') id: string,
    @Param('tool') tool: string,
    @Body() body: unknown,
  ) {
    const input = policySchema.parse(body);
    return toServerView(
      await this.registry.setPolicy(caller, id, tool, input, requestIdFrom(requestId)),
    );
  }

  /** The kill switch for a whole server. */
  @Put(':id/state')
  async setState(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestId: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { enabled } = stateSchema.parse(body);
    return toServerView(
      await this.registry.setEnabled(caller, id, enabled, requestIdFrom(requestId)),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestId: string | undefined,
    @Param('id') id: string,
  ): Promise<void> {
    await this.registry.remove(caller, id, requestIdFrom(requestId));
  }
}

/** What an authenticated user or agent can do with the approved tools. */
@Controller('v1/tools')
@RequireRoles(USER_ROLE)
export class ToolsController {
  constructor(private readonly invoker: ToolInvoker) {}

  /** Only the tools this caller could actually call. */
  @Get()
  async list(@CurrentPrincipal() caller: AuthenticatedPrincipal) {
    return { tools: await this.invoker.listFor(caller) };
  }

  @Post('call')
  @HttpCode(200)
  async call(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Headers('x-request-id') requestIdHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = callSchema.parse(body);
    const requestId = requestIdFrom(requestIdHeader);

    const result = await this.invoker.call(caller, input, requestId);

    res.setHeader('x-request-id', requestId);
    return result;
  }
}

@Controller('v1/audit')
@RequireRoles(AUDITOR_ROLE)
export class AuditController {
  constructor(@Inject(AUDIT_STORE) private readonly store: AuditStore) {}

  /** Newest first, this tenant only. */
  @Get()
  async query(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Query() query: unknown) {
    const filter = auditQuerySchema.parse(query);
    const { limit, ...rest } = filter;
    return { entries: await this.store.query(caller.tenantId, { limit, ...rest }) };
  }
}
