/** Who is calling, taken only from a verified token. Never from request headers or the body. */
export interface AuthenticatedPrincipal {
  /** Platform tenant (customer) the caller belongs to. */
  tenantId: string;
  /** Stable user (or service) identifier: the `oid` claim, falling back to `sub`. */
  userId: string;
  /** App roles, lowercased. These drive access trimming and admin-only operations. */
  roles: readonly string[];
  scopes: readonly string[];
  /** Token id (`jti`), useful for audit logs. */
  tokenId: string | undefined;
  expiresAt: Date;
  /**
   * The caller's original access token, kept so a service can exchange it for a downstream token
   * on the user's behalf. A credential: never log it or return it in a response.
   */
  accessToken: string;
}

export type AuthFailureReason =
  | 'missing_token'
  | 'malformed'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'missing_tenant'
  | 'invalid_tenant';

/**
 * Why a token was rejected. The reason is for server-side logs and tests only: clients get one
 * generic 401, so an attacker learns nothing about which check failed. The token itself is never
 * included in the message.
 */
export class AuthenticationError extends Error {
  constructor(readonly reason: AuthFailureReason) {
    super(`Authentication failed: ${reason}`);
    this.name = 'AuthenticationError';
  }
}

export class ForbiddenError extends Error {
  constructor(readonly requiredRoles: readonly string[]) {
    super(`Missing a required role (one of: ${requiredRoles.join(', ')})`);
    this.name = 'ForbiddenError';
  }
}
