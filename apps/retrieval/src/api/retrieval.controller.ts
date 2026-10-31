import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { createTenantContext } from '@genai/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { DocumentNotFoundError } from '../errors';
import { IndexingService } from '../index/indexing.service';
import type { ChunkFilter } from '../index/search-index';
import { SearchService } from '../search/search.service';
import { documentIdSchema, searchSchema, upsertDocumentSchema } from './schemas';

/**
 * Writing to the search index is a service-level operation: the ingestion pipeline's own
 * identity holds this role, end users never do (not even managers).
 */
export const INDEXER_ROLE = 'indexer';

/** The tenant in a path is only honoured for a caller who holds the indexer role. */
const tenantFromPath = (tenantId: string): string => createTenantContext({ tenantId }).tenantId;

@Controller('v1')
export class RetrievalController {
  constructor(
    private readonly indexing: IndexingService,
    private readonly searching: SearchService,
  ) {}

  /**
   * Replaces a tenant's document. The tenant is named in the path because the caller is a
   * service (the ingestion pipeline) acting for whichever tenant uploaded the document, and a
   * service identity has no customer tenant of its own. Idempotent: the same body twice leaves the
   * same state.
   */
  @RequireRoles(INDEXER_ROLE)
  @Put('tenants/:tenantId/index/documents/:documentId')
  upsert(
    @Param('tenantId') tenantId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    return this.indexing.upsertDocument(
      tenantFromPath(tenantId),
      documentIdSchema.parse(documentId),
      upsertDocumentSchema.parse(body),
    );
  }

  /** Whether a document is indexed and with which content hash, so unchanged uploads can be skipped. */
  @RequireRoles(INDEXER_ROLE)
  @Get('tenants/:tenantId/index/documents/:documentId')
  async info(@Param('tenantId') tenantId: string, @Param('documentId') documentId: string) {
    const info = await this.indexing.getDocument(
      tenantFromPath(tenantId),
      documentIdSchema.parse(documentId),
    );
    if (!info) throw new DocumentNotFoundError(documentId);
    return info;
  }

  @RequireRoles(INDEXER_ROLE)
  @Delete('tenants/:tenantId/index/documents/:documentId')
  async remove(@Param('tenantId') tenantId: string, @Param('documentId') documentId: string) {
    const deleted = await this.indexing.deleteDocument(
      tenantFromPath(tenantId),
      documentIdSchema.parse(documentId),
    );
    if (!deleted) throw new DocumentNotFoundError(documentId);
    return { documentId, deleted: true };
  }

  /**
   * Access trimming uses the caller's tenant and roles straight from the verified token. A client
   * can no longer widen its own view by sending a header, which is what makes the trimming real.
   */
  @Post('search')
  @HttpCode(200)
  async search(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Body() body: unknown) {
    const { filter, ...rest } = searchSchema.parse(body);
    const results = await this.searching.search(
      { tenantId: caller.tenantId, roles: caller.roles },
      { ...rest, ...(filter && { filter: filter satisfies ChunkFilter }) },
    );
    return { query: rest.query, mode: rest.mode, count: results.length, results };
  }
}
