import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { InvalidTenantError } from '@genai/shared';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ProviderError } from '../llm/provider-error';
import { AllProvidersFailedError } from '../resilience/llm-router';
import { QuotaExceededError, RateLimitedError } from './errors';

/** Maps domain errors to stable HTTP responses: `{ error: { code, message } }`. */
@Catch(
  RateLimitedError,
  QuotaExceededError,
  AllProvidersFailedError,
  ProviderError,
  InvalidTenantError,
  ZodError,
)
export class GatewayExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, extra: object = {}) =>
      res.status(status).json({ error: { code, message, ...extra } });

    if (error instanceof RateLimitedError) {
      const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      res.setHeader('retry-after', String(seconds));
      return void send(429, 'rate_limited', error.message, { retryAfterSeconds: seconds });
    }
    if (error instanceof QuotaExceededError) {
      return void send(429, 'quota_exceeded', error.message, {
        limit: error.limit,
        used: error.used,
      });
    }
    if (error instanceof AllProvidersFailedError) {
      return void send(503, 'upstream_unavailable', 'All LLM deployments are unavailable');
    }
    if (error instanceof ProviderError) {
      // Reaches here only when upstream rejected the request itself (400/422): our caller's fault.
      return void send(400, 'upstream_rejected_request', 'The model rejected this request');
    }
    if (error instanceof InvalidTenantError) {
      return void send(400, 'invalid_tenant', 'x-tenant-id header is missing or invalid');
    }
    if (error instanceof ZodError) {
      return void send(400, 'invalid_request', 'Request body failed validation', {
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
  }
}
