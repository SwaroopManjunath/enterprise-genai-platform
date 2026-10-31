import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IngestionService } from './ingestion.service';
import { submitSchema } from './schemas';

/** Operating the pipeline (inspecting and replaying failed jobs) is separate from using it. */
export const INGESTION_ADMIN_ROLE = 'ingestion-admin';

/** The tenant always comes from the verified token, never from a header or the request body. */
@Controller('v1')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  /** 202: accepted for background processing; poll the job for the outcome. */
  @Post('documents')
  @HttpCode(202)
  async submit(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Body() body: unknown) {
    const job = await this.ingestion.submit(caller.tenantId, submitSchema.parse(body));
    return { jobId: job.jobId, documentId: job.documentId, status: job.status };
  }

  @Get('ingestions/:jobId')
  getJob(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Param('jobId') jobId: string) {
    return this.ingestion.getJob(caller.tenantId, jobId);
  }

  @Get('documents/:documentId')
  getDocument(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('documentId') documentId: string,
  ) {
    return this.ingestion.getDocument(caller.tenantId, documentId);
  }

  @Get('documents/:documentId/chunks')
  async getChunks(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('documentId') documentId: string,
  ) {
    return { chunks: await this.ingestion.getChunks(caller.tenantId, documentId) };
  }

  @RequireRoles(INGESTION_ADMIN_ROLE)
  @Get('dead-letters')
  async deadLetters(@CurrentPrincipal() caller: AuthenticatedPrincipal) {
    return { deadLetters: await this.ingestion.listDeadLetters(caller.tenantId) };
  }

  @RequireRoles(INGESTION_ADMIN_ROLE)
  @Post('dead-letters/:jobId/requeue')
  @HttpCode(202)
  requeue(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Param('jobId') jobId: string) {
    return this.ingestion.requeueDeadLetter(caller.tenantId, jobId);
  }
}
