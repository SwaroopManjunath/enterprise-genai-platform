import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationError, ForbiddenError } from '../principal';

/**
 * Clients get one generic 401 whatever went wrong (expired, wrong audience, forged signature), so
 * an attacker cannot use the response to learn which check to get around. The specific reason is
 * logged server-side for operators.
 */
@Catch(AuthenticationError, ForbiddenError)
export class AuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Auth');

  catch(error: AuthenticationError | ForbiddenError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (error instanceof AuthenticationError) {
      this.logger.warn(`rejected request: ${error.reason}`);
      res
        .status(401)
        .setHeader('www-authenticate', 'Bearer')
        .json({ error: { code: 'unauthorized', message: 'Authentication required' } });
      return;
    }

    this.logger.warn(`forbidden: ${error.message}`);
    res
      .status(403)
      .json({ error: { code: 'forbidden', message: 'You do not have permission to do this' } });
  }
}
