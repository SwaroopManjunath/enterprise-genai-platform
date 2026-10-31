import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedPrincipal } from '../principal';

export const IS_PUBLIC_KEY = 'genai:public';
export const REQUIRED_ROLES_KEY = 'genai:required-roles';

/** Opts a route out of authentication (health checks). Everything else requires a valid token. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires the caller to hold at least one of these roles (case-insensitive). */
export const RequireRoles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(
    REQUIRED_ROLES_KEY,
    roles.map((r) => r.toLowerCase()),
  );

export type RequestWithPrincipal = Request & { principal?: AuthenticatedPrincipal };

/** The verified caller. Only available on routes behind the guard. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const principal = context.switchToHttp().getRequest<RequestWithPrincipal>().principal;
    if (!principal) throw new Error('CurrentPrincipal used on a route without the auth guard');
    return principal;
  },
);
