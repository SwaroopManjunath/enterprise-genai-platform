import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { InvalidTenantError } from '@genai/shared';
import type { Response } from 'express';
import { ZodError } from 'zod';
import {
  ConcurrentModificationError,
  InvalidExperimentError,
  InvalidPromptError,
  PromptNotFoundError,
  VersionNotFoundError,
} from '../domain/errors';
import { MissingVariablesError } from '../domain/template';

/** Maps domain errors to stable HTTP responses: `{ error: { code, message } }`. */
@Catch(
  PromptNotFoundError,
  VersionNotFoundError,
  ConcurrentModificationError,
  InvalidPromptError,
  InvalidExperimentError,
  MissingVariablesError,
  InvalidTenantError,
  ZodError,
)
export class RegistryExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, extra: object = {}) =>
      void res.status(status).json({ error: { code, message, ...extra } });

    if (error instanceof PromptNotFoundError) return send(404, 'prompt_not_found', error.message);
    if (error instanceof VersionNotFoundError) {
      return send(404, 'version_not_found', error.message);
    }
    if (error instanceof ConcurrentModificationError) {
      return send(409, 'conflict', `${error.message}; reload and retry`);
    }
    if (error instanceof InvalidPromptError) return send(400, 'invalid_prompt', error.message);
    if (error instanceof InvalidExperimentError) {
      return send(400, 'invalid_experiment', error.message);
    }
    if (error instanceof MissingVariablesError) {
      return send(400, 'missing_variables', error.message, { missing: error.missing });
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
