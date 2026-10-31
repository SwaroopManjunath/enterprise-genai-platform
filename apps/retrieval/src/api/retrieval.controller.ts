import { Body, Controller, Delete, Headers, HttpCode, Param, Post, Put } from '@nestjs/common';
import { createTenantContext } from '@genai/shared';
import { DocumentNotFoundError } from '../errors';
import { IndexingService } from '../index/indexing.service';
import type { ChunkFilter } from '../index/search-index';
import { SearchService } from '../search/search.service';
import { parseRoles, searchSchema, upsertDocumentSchema } from './schemas';

/** Interim identity: tenant and roles come from headers until Step 6 adds validated token claims. */
const tenantOf = (header: string | undefined): string =>
  createTenantContext({ tenantId: header ?? '' }).tenantId;

@Controller('v1')
export class RetrievalController {
  constructor(
    private readonly indexing: IndexingService,
    private readonly searching: SearchService,
  ) {}

  /** Replaces a document's chunks. Idempotent: sending the same body twice leaves the same state. */
  @Put('index/documents/:documentId')
  upsert(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    return this.indexing.upsertDocument(
      tenantOf(tenant),
      documentId,
      upsertDocumentSchema.parse(body),
    );
  }

  @Delete('index/documents/:documentId')
  async remove(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Param('documentId') documentId: string,
  ) {
    if (!(await this.indexing.deleteDocument(tenantOf(tenant), documentId))) {
      throw new DocumentNotFoundError(documentId);
    }
    return { documentId, deleted: true };
  }

  @Post('search')
  @HttpCode(200)
  async search(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Headers('x-roles') roles: string | undefined,
    @Body() body: unknown,
  ) {
    const { filter, ...rest } = searchSchema.parse(body);
    const results = await this.searching.search(
      { tenantId: tenantOf(tenant), roles: parseRoles(roles) },
      { ...rest, ...(filter && { filter: filter satisfies ChunkFilter }) },
    );
    return { query: rest.query, mode: rest.mode, count: results.length, results };
  }
}
