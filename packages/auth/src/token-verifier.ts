import { readFileSync } from 'node:fs';
import { InvalidTenantError, createTenantContext } from '@genai/shared';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { AuthConfig } from './config';
import { AuthenticationError, type AuthenticatedPrincipal } from './principal';

/** Entra ID signs access tokens with RS256. Pinning the algorithm blocks `none` and key-confusion attacks. */
const ALLOWED_ALGORITHMS = ['RS256'];

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Verifies bearer tokens and turns their claims into an AuthenticatedPrincipal.
 *
 * Checks, all mandatory: signature against the issuer's published keys, RS256 only, exact issuer,
 * exact audience, expiry (`exp` is required, not optional), not-before, and a well-formed tenant.
 */
export class TokenVerifier {
  constructor(
    private readonly config: Pick<
      AuthConfig,
      'issuer' | 'audience' | 'tenantClaim' | 'clockToleranceSec'
    >,
    private readonly keys: JWTVerifyGetKey,
  ) {}

  async verify(token: string): Promise<AuthenticatedPrincipal> {
    if (!token) throw new AuthenticationError('missing_token');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: this.config.clockToleranceSec,
        requiredClaims: ['exp'],
      }));
    } catch (error) {
      throw new AuthenticationError(classify(error));
    }
    return this.toPrincipal(payload, token);
  }

  private toPrincipal(payload: JWTPayload, accessToken: string): AuthenticatedPrincipal {
    const rawTenant = payload[this.config.tenantClaim];
    if (typeof rawTenant !== 'string' || rawTenant === '') {
      throw new AuthenticationError('missing_tenant');
    }

    let tenantId: string;
    try {
      tenantId = createTenantContext({ tenantId: rawTenant.toLowerCase() }).tenantId;
    } catch (error) {
      if (error instanceof InvalidTenantError) throw new AuthenticationError('invalid_tenant');
      throw error;
    }

    const userId = [payload['oid'], payload.sub].find(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    if (!userId) throw new AuthenticationError('invalid_claims');

    return {
      tenantId,
      userId,
      roles: [...new Set(strings(payload['roles']).map((r) => r.trim().toLowerCase()))].filter(
        Boolean,
      ),
      scopes: typeof payload['scp'] === 'string' ? payload['scp'].split(' ').filter(Boolean) : [],
      tokenId: payload.jti,
      expiresAt: new Date((payload.exp as number) * 1000),
      accessToken,
    };
  }
}

function classify(error: unknown): ConstructorParameters<typeof AuthenticationError>[0] {
  if (error instanceof joseErrors.JWTExpired) return 'expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return error.claim === 'nbf' ? 'not_yet_valid' : 'invalid_claims';
  }
  if (
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JOSEAlgNotAllowed
  ) {
    return 'invalid_signature';
  }
  return 'malformed';
}

/** Builds the verifier from configuration: remote key set in production, a file in development. */
export function createTokenVerifier(config: AuthConfig): TokenVerifier {
  const keys: JWTVerifyGetKey = config.jwksUrl
    ? createRemoteJWKSet(new URL(config.jwksUrl), {
        cooldownDuration: 30_000,
        timeoutDuration: 5_000,
      })
    : createLocalJWKSet(JSON.parse(readFileSync(config.jwksFile as string, 'utf8')));
  return new TokenVerifier(config, keys);
}
