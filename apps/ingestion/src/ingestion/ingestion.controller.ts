import { CurrentPrincipal, RequireRoles, type AuthenticatedPrincipal } from '@genai/auth';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IngestionService } from './ingestion.service';
import { submitSchema } from './schemas';

/**
 * What goes into the assistant's knowledge is a privileged act: an uploaded document is later
 * quoted and cited as evidence, and its access list decides who can read it. Only people with this
 * role may upload or look at upload status.
 */
export const DOCUMENT_ADMIN_ROLE = 'document-admin';

/** Operating the pipeline (inspecting and replaying failed jobs) is separate from using it. */
export const INGESTION_ADMIN_ROLE = 'ingestion-admin';

/**
 * The tenant always comes from the verified token. There is no endpoint that returns document
 * content: only the retrieval service serves it, after trimming by the caller's tenant and roles.
 */
@Controller('v1')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  /** 202: accepted for background processing; poll the job for the outcome. */
  @RequireRoles(DOCUMENT_ADMIN_ROLE)
  @Post('documents')
  @HttpCode(202)
  async submit(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Body() body: unknown) {
    const job = await this.ingestion.submit(caller.tenantId, submitSchema.parse(body));
    return { jobId: job.jobId, documentId: job.documentId, status: job.status };
  }

  @RequireRoles(DOCUMENT_ADMIN_ROLE)
  @Get('ingestions/:jobId')
  getJob(@CurrentPrincipal() caller: AuthenticatedPrincipal, @Param('jobId') jobId: string) {
    return this.ingestion.getJob(caller.tenantId, jobId);
  }

  /** Whether a document is indexed (hash and chunk count only, never its content). */
  @RequireRoles(DOCUMENT_ADMIN_ROLE)
  @Get('documents/:documentId')
  getDocument(
    @CurrentPrincipal() caller: AuthenticatedPrincipal,
    @Param('documentId') documentId: string,
  ) {
    return this.ingestion.getDocument(caller.tenantId, documentId);
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
