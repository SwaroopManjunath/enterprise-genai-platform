import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put } from '@nestjs/common';
import { createTenantContext } from '@genai/shared';
import type { PromptRecord } from '../domain/types';
import { PromptRegistryService } from './prompt-registry.service';
import {
  activateSchema,
  createVersionSchema,
  experimentSchema,
  resolveSchema,
  versionParamSchema,
} from './schemas';

/**
 * Interim identity: tenant and actor come from headers. Step 6 replaces both with claims from a
 * validated Entra ID token, so clients can no longer choose who they are.
 */
function tenantOf(header: string | undefined): string {
  return createTenantContext({ tenantId: header ?? '' }).tenantId;
}

function summarize(record: PromptRecord) {
  return {
    name: record.name,
    activeVersion: record.activeVersion,
    versionCount: record.versions.length,
    experimentRunning: record.experiment !== undefined,
  };
}

@Controller('v1/prompts')
export class RegistryController {
  constructor(private readonly registry: PromptRegistryService) {}

  @Get()
  async list(@Headers('x-tenant-id') tenant: string | undefined) {
    const records = await this.registry.list(tenantOf(tenant));
    return { prompts: records.map(summarize) };
  }

  @Get(':name')
  get(@Headers('x-tenant-id') tenant: string | undefined, @Param('name') name: string) {
    return this.registry.get(tenantOf(tenant), name);
  }

  @Post(':name/versions')
  async createVersion(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Headers('x-user-id') user: string | undefined,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const input = createVersionSchema.parse(body);
    return this.registry.createVersion(tenantOf(tenant), name, {
      template: input.template,
      ...(input.note !== undefined && { note: input.note }),
      ...(user !== undefined && { createdBy: user }),
    });
  }

  @Get(':name/versions/:version')
  getVersion(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Param('name') name: string,
    @Param('version') version: string,
  ) {
    return this.registry.getVersion(tenantOf(tenant), name, versionParamSchema.parse(version));
  }

  @Put(':name/active')
  activate(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Headers('x-user-id') user: string | undefined,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const { version } = activateSchema.parse(body);
    return this.registry.activate(tenantOf(tenant), name, version, user);
  }

  @Put(':name/experiment')
  setExperiment(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const { variants } = experimentSchema.parse(body);
    return this.registry.setExperiment(tenantOf(tenant), name, variants);
  }

  @Delete(':name/experiment')
  clearExperiment(@Headers('x-tenant-id') tenant: string | undefined, @Param('name') name: string) {
    return this.registry.clearExperiment(tenantOf(tenant), name);
  }

  @Post(':name/resolve')
  @HttpCode(200)
  resolve(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    return this.registry.resolve(tenantOf(tenant), name, resolveSchema.parse(body ?? {}));
  }
}
