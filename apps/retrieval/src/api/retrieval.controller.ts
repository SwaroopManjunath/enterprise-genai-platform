import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Delete, HttpCode, Param, Post, Put } from '@nestjs/common';
import { DocumentNotFoundError } from '../errors';
import { IndexingService } from '../index/indexing.service';
import type { ChunkFilter } from '../index/search-index';
import { SearchService } from '../search/search.service';
import { searchSchema, upsertDocumentSchema } from './schemas';

/**
 * Writing to the search index is a service-level operation (the ingestion pipeline's app role), not
 * something an end user does, so it needs its own role.
 */
export const INDEXER_ROLE = 'indexer';

@Controller('v1')
export class RetrievalController {
  constructor(
    private readonly indexing: IndexingService,
    private readonly searching: SearchService,
  ) {}

  /** Replaces a document's chunks. Idempotent: sending the same body twice leaves the same state. */
  @RequireRoles(INDEXER_ROLE)
  @Put('index/documents/:documentId')
  upsert(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    return this.indexing.upsertDocument(
      caller.tenantId,
      documentId,
      upsertDocumentSchema.parse(body),
    );
  }

  @RequireRoles(INDEXER_ROLE)
  @Delete('index/documents/:documentId')
  async remove(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('documentId') documentId: string,
  ) {
    if (!(await this.indexing.deleteDocument(caller.tenantId, documentId))) {
      throw new DocumentNotFoundError(documentId);
    }
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
