import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import type { PromptRecord } from '../domain/types';
import { PromptRegistryService } from './prompt-registry.service';
import {
  activateSchema,
  createVersionSchema,
  experimentSchema,
  resolveSchema,
  versionParamSchema,
} from './schemas';

/** Changing what the AI is told is a privileged act: reading and resolving are open to the tenant. */
export const PROMPT_ADMIN_ROLE = 'prompt-admin';

function summarize(record: PromptRecord) {
  return {
    name: record.name,
    activeVersion: record.activeVersion,
    versionCount: record.versions.length,
    experimentRunning: record.experiment !== undefined,
  };
}

/**
 * Tenant and actor come from the verified token. The audit trail therefore records who really did
 * a change, not whatever a client claimed in a header.
 */
@Controller('v1/prompts')
export class RegistryController {
  constructor(private readonly registry: PromptRegistryService) {}

  @Get()
  async list(@CurrentPrincipal() caller: AuthenticatedPrincipal) {
    const records = await this.registry.list(caller.tenantId);
    return { prompts: records.map(summarize) };
  }

  @Get(':name')
  get(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Param('name') name: string) {
    return this.registry.get(caller.tenantId, name);
  }

  @RequireRoles(PROMPT_ADMIN_ROLE)
  @Post(':name/versions')
  async createVersion(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const input = createVersionSchema.parse(body);
    return this.registry.createVersion(caller.tenantId, name, {
      template: input.template,
      createdBy: caller.userId,
      ...(input.note !== undefined && { note: input.note }),
    });
  }

  @Get(':name/versions/:version')
  getVersion(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('name') name: string,
    @Param('version') version: string,
  ) {
    return this.registry.getVersion(caller.tenantId, name, versionParamSchema.parse(version));
  }

  @RequireRoles(PROMPT_ADMIN_ROLE)
  @Put(':name/active')
  activate(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const { version } = activateSchema.parse(body);
    return this.registry.activate(caller.tenantId, name, version, caller.userId);
  }

  @RequireRoles(PROMPT_ADMIN_ROLE)
  @Put(':name/experiment')
  setExperiment(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const { variants } = experimentSchema.parse(body);
    return this.registry.setExperiment(caller.tenantId, name, variants);
  }

  @RequireRoles(PROMPT_ADMIN_ROLE)
  @Delete(':name/experiment')
  clearExperiment(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Param('name') name: string) {
    return this.registry.clearExperiment(caller.tenantId, name);
  }

  @Post(':name/resolve')
  @HttpCode(200)
  resolve(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    return this.registry.resolve(caller.tenantId, name, resolveSchema.parse(body ?? {}));
  }
}
