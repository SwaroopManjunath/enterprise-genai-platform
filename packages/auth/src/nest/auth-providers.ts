import type { Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { loadAuthConfig } from '../config';
import type { TokenVerifier } from '../token-verifier';
import { createTokenVerifier } from '../token-verifier';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthGuard } from './auth.guard';

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/**
 * Everything a service adds to its module to authenticate every route: the verifier (built from
 * environment configuration, failing fast when it is missing), the global guard and the filter
 * that turns auth failures into 401/403. Tests override TOKEN_VERIFIER with a TestIssuer verifier.
 */
export function authProviders(): Provider[] {
  return [
    { provide: TOKEN_VERIFIER, useFactory: () => createTokenVerifier(loadAuthConfig()) },
    {
      provide: APP_GUARD,
      inject: [TOKEN_VERIFIER, Reflector],
      useFactory: (verifier: TokenVerifier, reflector: Reflector) =>
        new AuthGuard(verifier, reflector),
    },
    { provide: APP_FILTER, useClass: AuthExceptionFilter },
  ];
}
