import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { createTenantContext } from '@genai/shared';
import { IngestionService } from './ingestion.service';
import { submitSchema } from './schemas';

/** Interim identity: the tenant comes from a header until Step 6 adds validated token claims. */
function tenantOf(header: string | undefined): string {
  return createTenantContext({ tenantId: header ?? '' }).tenantId;
}

@Controller('v1')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  /** 202: accepted for background processing; poll the job for the outcome. */
  @Post('documents')
  @HttpCode(202)
  async submit(@Headers('x-tenant-id') tenant: string | undefined, @Body() body: unknown) {
    const job = await this.ingestion.submit(tenantOf(tenant), submitSchema.parse(body));
    return { jobId: job.jobId, documentId: job.documentId, status: job.status };
  }

  @Get('ingestions/:jobId')
  getJob(@Headers('x-tenant-id') tenant: string | undefined, @Param('jobId') jobId: string) {
    return this.ingestion.getJob(tenantOf(tenant), jobId);
  }

  @Get('documents/:documentId')
  getDocument(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Param('documentId') documentId: string,
  ) {
    return this.ingestion.getDocument(tenantOf(tenant), documentId);
  }

  @Get('documents/:documentId/chunks')
  async getChunks(
    @Headers('x-tenant-id') tenant: string | undefined,
    @Param('documentId') documentId: string,
  ) {
    return { chunks: await this.ingestion.getChunks(tenantOf(tenant), documentId) };
  }

  @Get('dead-letters')
  async deadLetters(@Headers('x-tenant-id') tenant: string | undefined) {
    return { deadLetters: await this.ingestion.listDeadLetters(tenantOf(tenant)) };
  }

  @Post('dead-letters/:jobId/requeue')
  @HttpCode(202)
  requeue(@Headers('x-tenant-id') tenant: string | undefined, @Param('jobId') jobId: string) {
    return this.ingestion.requeueDeadLetter(tenantOf(tenant), jobId);
  }
}
