import { OboExchangeError } from '@genai/auth';
import { DownstreamError } from '@genai/shared';
import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import {
  ConcurrentRunUpdateError,
  GoalBlockedError,
  InvalidDecisionError,
  NotRunOwnerError,
  RunNotFoundError,
} from '../domain/errors';

/**
 * Maps failures to what the caller can act on, without leaking internals. A dependency being down
 * or slow is a temporary 503; one rejecting OUR credentials is our misconfiguration (502); the
 * user's own limit being hit (429) is passed on with its Retry-After.
 */
@Catch(
  RunNotFoundError,
  NotRunOwnerError,
  InvalidDecisionError,
  ConcurrentRunUpdateError,
  GoalBlockedError,
  DownstreamError,
  OboExchangeError,
  ZodError,
)
export class RunsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Runs');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, extra: object = {}) =>
      void res.status(status).json({ error: { code, message, ...extra } });
    const unavailable = () =>
      send(503, 'agent_unavailable', 'The agent is temporarily unavailable. Try again shortly.');

    if (error instanceof RunNotFoundError) return send(404, 'run_not_found', 'Run not found.');
    if (error instanceof NotRunOwnerError) {
      return send(403, 'not_run_owner', 'Only the user who started this run can do that.');
    }
    if (error instanceof InvalidDecisionError) return send(409, 'invalid_decision', error.message);
    if (error instanceof ConcurrentRunUpdateError) {
      return send(409, 'conflict', 'The run was changed by another request. Fetch it and retry.');
    }

    if (error instanceof GoalBlockedError) {
      // Score and signal names for operators; the caller learns only that it was refused.
      this.logger.warn(
        `goal blocked by guardrails (score ${error.report.injectionScore}, signals: ${error.report.injectionSignals.join(', ')})`,
      );
      return send(422, 'guardrail_blocked', 'This request cannot be processed.');
    }

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
      return send(502, 'dependency_auth_failed', 'The agent could not act on your behalf.');
    }

    if (error instanceof DownstreamError) {
      this.logger.warn(error.message);
      if (error.kind !== 'http' || (error.status ?? 0) >= 500) return unavailable();

      if (error.status === 429) {
        if (error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds));
        const code = error.code === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited';
        return send(429, code, 'Your usage limit has been reached.', {
          ...(error.retryAfterSeconds && { retryAfterSeconds: error.retryAfterSeconds }),
        });
      }
      if (error.status === 401 || error.status === 403) {
        return send(502, 'dependency_auth_failed', 'The agent could not act on your behalf.');
      }
      return send(502, 'dependency_error', 'A required service rejected the request.');
    }
  }
}
