import { z } from 'zod';

const envSchema = z
  .object({
    /** Exact `iss` value tokens must carry, e.g. https://login.microsoftonline.com/<tid>/v2.0 */
    AUTH_ISSUER: z.string().min(1),
    /** Exact `aud` value tokens must carry: this API's application (client) id or App ID URI. */
    AUTH_AUDIENCE: z.string().min(1),
    /** Remote key set (Entra ID: .../discovery/v2.0/keys). Fetched, cached and refreshed. */
    AUTH_JWKS_URL: z.string().url().optional(),
    /** Local key set file, for development and tests only. Exactly one of URL or file. */
    AUTH_JWKS_FILE: z.string().min(1).optional(),
    /** Claim holding the platform tenant. Entra ID's directory tenant id is `tid`. */
    AUTH_TENANT_CLAIM: z.string().min(1).default('tid'),
    /** Allowed clock difference between us and the identity provider. */
    AUTH_CLOCK_TOLERANCE_SEC: z.coerce.number().int().min(0).max(300).default(30),
  })
  .refine((e) => Boolean(e.AUTH_JWKS_URL) !== Boolean(e.AUTH_JWKS_FILE), {
    message: 'set exactly one of AUTH_JWKS_URL or AUTH_JWKS_FILE',
    path: ['AUTH_JWKS_URL'],
  });

export interface AuthConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  jwksFile?: string;
  tenantClaim: string;
  clockToleranceSec: number;
}

/**
 * Fails fast. There is deliberately no "auth disabled" mode and no default issuer: a service that
 * is missing its auth settings refuses to start instead of silently accepting everyone.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `${i.path.join('.') || 'config'}: ${i.message}`,
    );
    throw new Error(`Invalid auth configuration (${problems.join('; ')})`);
  }
  const e = parsed.data;
  return {
    issuer: e.AUTH_ISSUER,
    audience: e.AUTH_AUDIENCE,
    ...(e.AUTH_JWKS_URL && { jwksUrl: e.AUTH_JWKS_URL }),
    ...(e.AUTH_JWKS_FILE && { jwksFile: e.AUTH_JWKS_FILE }),
    tenantClaim: e.AUTH_TENANT_CLAIM,
    clockToleranceSec: e.AUTH_CLOCK_TOLERANCE_SEC,
  };
}
