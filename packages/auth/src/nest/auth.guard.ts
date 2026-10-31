import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthenticationError, ForbiddenError } from '../principal';
import type { TokenVerifier } from '../token-verifier';
import { IS_PUBLIC_KEY, REQUIRED_ROLES_KEY, type RequestWithPrincipal } from './decorators';

/**
 * Registered globally, so a new route is protected unless someone explicitly marks it `@Public()`.
 * "Secure by default" means forgetting a decorator fails closed, not open.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = await this.verifier.verify(bearerToken(request.headers.authorization));

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_ROLES_KEY,
      targets,
    );
    if (required?.length && !required.some((role) => principal.roles.includes(role))) {
      throw new ForbiddenError(required);
    }

    request.principal = principal;
    return true;
  }
}

/** Extracts the token from `Authorization: Bearer <token>`; anything else counts as no token. */
export function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match) throw new AuthenticationError('missing_token');
  return match[1] as string;
}
