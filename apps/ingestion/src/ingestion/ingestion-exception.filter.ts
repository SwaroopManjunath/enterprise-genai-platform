import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { InvalidTenantError } from '@genai/shared';
import type { Response } from 'express';
import { ZodError } from 'zod';
import {
  DeadLetterNotFoundError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  JobNotFoundError,
} from '../domain/errors';

/** Maps domain errors to stable HTTP responses: `{ error: { code, message } }`. */
@Catch(
  JobNotFoundError,
  DocumentNotFoundError,
  DeadLetterNotFoundError,
  DocumentTooLargeError,
  InvalidTenantError,
  ZodError,
)
export class IngestionExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, extra: object = {}) =>
      void res.status(status).json({ error: { code, message, ...extra } });

    if (error instanceof JobNotFoundError) return send(404, 'job_not_found', error.message);
    if (error instanceof DocumentNotFoundError) {
      return send(404, 'document_not_found', error.message);
    }
    if (error instanceof DeadLetterNotFoundError) {
      return send(404, 'dead_letter_not_found', error.message);
    }
    if (error instanceof DocumentTooLargeError) {
      return send(413, 'document_too_large', error.message, { maxBytes: error.maxBytes });
    }
    if (error instanceof InvalidTenantError) {
      return send(400, 'invalid_tenant', 'x-tenant-id header is missing or invalid');
    }
    if (error instanceof ZodError) {
      return send(400, 'invalid_request', 'Request failed validation', {
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
  }
}
