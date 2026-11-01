import { OboExchangeError } from '@genai/auth';
import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import {
  ConcurrentUpdateError,
  EgressBlockedError,
  InvalidArgumentsError,
  LimitExceededError,
  RateLimitedError,
  ReviewMismatchError,
  ServerConflictError,
  ServerNotFoundError,
  ToolChangedError,
  ToolNotAvailableError,
  ToolQuarantinedError,
  UpstreamError,
} from '../domain/errors';

/**
 * Maps failures to what the caller can act on. A server's own error text is never relayed (it is
 * untrusted), a tool the caller may not use is a plain 404, and a dependency problem is a 502 or
 * 504 with a generic message; the detail goes to the logs.
 */
@Catch(
  ServerNotFoundError,
  ToolNotAvailableError,
  ServerConflictError,
  LimitExceededError,
  EgressBlockedError,
  UpstreamError,
  ToolChangedError,
  ReviewMismatchError,
  ToolQuarantinedError,
  InvalidArgumentsError,
  RateLimitedError,
  ConcurrentUpdateError,
  OboExchangeError,
  ZodError,
)
export class McpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('McpGateway');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, extra: object = {}) =>
      void res.status(status).json({ error: { code, message, ...extra } });

    if (error instanceof ServerNotFoundError)
      return send(404, 'server_not_found', 'Server not found.');
    if (error instanceof ToolNotAvailableError)
      return send(404, 'tool_not_available', 'Tool not available.');
    if (error instanceof ServerConflictError) return send(409, 'server_exists', error.message);
    if (error instanceof LimitExceededError) return send(409, 'limit_exceeded', error.message);
    if (error instanceof EgressBlockedError)
      return send(400, 'server_url_not_allowed', error.message);
    if (error instanceof ToolChangedError) {
      return send(
        409,
        'tool_changed',
        'This tool changed and is waiting for an admin to review it.',
      );
    }
    if (error instanceof ReviewMismatchError) {
      return send(409, 'definition_changed', 'The tool definition changed since it was reviewed.');
    }
    if (error instanceof ToolQuarantinedError) {
      return send(409, 'tool_quarantined', 'A quarantined tool cannot be approved.', {
        reasons: error.reasons,
      });
    }
    if (error instanceof ConcurrentUpdateError) {
      return send(
        409,
        'conflict',
        'The server was changed by another request. Fetch it and retry.',
      );
    }
    if (error instanceof InvalidArgumentsError) {
      return send(400, 'invalid_arguments', 'The arguments do not match the tool input schema.', {
        issues: error.issues,
      });
    }
    if (error instanceof RateLimitedError) {
      res.setHeader('retry-after', String(error.retryAfterSeconds));
      return send(429, 'rate_limited', 'Too many calls. Try again shortly.', {
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }

    if (error instanceof ZodError) {
      return send(400, 'invalid_request', 'Request failed validation', {
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    if (error instanceof UpstreamError) {
      this.logger.warn(error.message);
      if (error.kind === 'timeout')
        return send(504, 'upstream_timeout', 'The tool server did not answer in time.');
      return send(502, 'upstream_error', 'The tool server could not be used.');
    }

    if (error instanceof OboExchangeError) {
      this.logger.warn(`token exchange failed: ${error.code}`);
      if (error.interactionRequired) {
        return send(403, 'interaction_required', 'Additional sign-in or consent is required.');
      }
      if (error.code === 'identity_provider_unreachable') {
        return send(503, 'gateway_unavailable', 'The gateway is temporarily unavailable.');
      }
      return send(502, 'dependency_auth_failed', 'The gateway could not act on your behalf.');
    }
  }
}
