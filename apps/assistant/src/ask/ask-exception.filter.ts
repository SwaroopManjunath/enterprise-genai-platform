import { OboExchangeError } from '@genai/auth';
import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { DownstreamError } from '../clients/http-json-client';

/**
 * Maps failures to what the caller can act on, without leaking internals:
 *  - the user's own limit being hit (429) is passed on, with its Retry-After;
 *  - a dependency being down or slow is a temporary 503;
 *  - a dependency rejecting OUR credentials is our misconfiguration (502), not the user's fault.
 */
@Catch(DownstreamError, OboExchangeError, ZodError)
export class AskExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Ask');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, extra: object = {}) =>
      void res.status(status).json({ error: { code, message, ...extra } });
    const unavailable = () =>
      send(
        503,
        'assistant_unavailable',
        'The assistant is temporarily unavailable. Try again shortly.',
      );

    if (error instanceof ZodError) {
      return send(400, 'invalid_request', 'Request failed validation', {
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    if (error instanceof OboExchangeError) {
      this.logger.warn(`token exchange failed: ${error.code}`);
      if (error.interactionRequired) {
        return send(403, 'interaction_required', 'Additional sign-in or consent is required.');
      }
      if (error.code === 'identity_provider_unreachable') return unavailable();
      return send(502, 'dependency_auth_failed', 'The assistant could not act on your behalf.');
    }

    if (error instanceof DownstreamError) {
      this.logger.warn(`${error.message}`);
      if (error.kind !== 'http' || (error.status ?? 0) >= 500) return unavailable();

      if (error.status === 429) {
        if (error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds));
        const code = error.code === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited';
        return send(429, code, 'Your usage limit has been reached.', {
          ...(error.retryAfterSeconds && { retryAfterSeconds: error.retryAfterSeconds }),
        });
      }
      if (error.status === 401 || error.status === 403) {
        return send(502, 'dependency_auth_failed', 'The assistant could not act on your behalf.');
      }
      return send(502, 'dependency_error', 'A required service rejected the request.');
    }
  }
}
