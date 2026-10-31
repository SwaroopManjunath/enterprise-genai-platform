import { createHash } from 'node:crypto';
import type { SecretProvider } from '../secrets/secret-provider';

/**
 * Exchanges the caller's access token for a token to call a downstream API **as that user**.
 *
 * Why not just call the downstream service with the service's own credentials? Then the
 * downstream sees "the assistant", not "Alice", so it cannot apply Alice's permissions, and every
 * user would effectively inherit the assistant's access. With the on-behalf-of flow the downstream
 * service validates a token that still names Alice, so "the AI only sees what the user may see"
 * holds across service hops.
 */
export interface OboTokenClient {
  exchange(userAccessToken: string, scope: string): Promise<string>;
}

export const OBO_CLIENT = Symbol('OBO_CLIENT');

/** The identity provider refused the exchange. `code` is its error code, e.g. `invalid_grant`. */
export class OboExchangeError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`On-behalf-of token exchange failed: ${code}`);
    this.name = 'OboExchangeError';
  }

  /** The user must complete MFA or consent first; retrying will not help. */
  get interactionRequired(): boolean {
    return this.code === 'interaction_required' || this.code === 'consent_required';
  }
}

export interface EntraOboOptions {
  /** e.g. https://login.microsoftonline.com/<directory-tenant>/oauth2/v2.0/token */
  tokenEndpoint: string;
  /** This service's application (client) id. */
  clientId: string;
  /** Name of this service's client secret in the SecretProvider (Key Vault). */
  clientSecretName: string;
  secrets: SecretProvider;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Reuse a token until it has this many seconds left. Default 60. */
  refreshSkewSec?: number;
  /** Upper bound on cached tokens, so memory cannot grow with the user count. Default 1000. */
  maxCacheEntries?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export function entraTokenEndpoint(
  directoryTenant: string,
  authority = 'https://login.microsoftonline.com',
): string {
  if (!/^[0-9A-Za-z.-]{1,128}$/.test(directoryTenant)) {
    throw new Error('Invalid directory tenant for the token endpoint');
  }
  return `${authority.replace(/\/+$/, '')}/${directoryTenant}/oauth2/v2.0/token`;
}

/** Microsoft Entra ID on-behalf-of flow (OAuth 2.0 JWT bearer grant). */
export class EntraOboClient implements OboTokenClient {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly maxEntries: number;

  constructor(private readonly options: EntraOboOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = (options.refreshSkewSec ?? 60) * 1000;
    this.maxEntries = options.maxCacheEntries ?? 1000;
  }

  async exchange(userAccessToken: string, scope: string): Promise<string> {
    // The key is a hash, so the cache never holds the user's raw token as a map key.
    const key = createHash('sha256').update(`${userAccessToken}\0${scope}`).digest('hex');

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.refreshSkewMs > this.now()) return cached.token;

    // Concurrent requests for the same user and scope share one exchange instead of stampeding.
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.requestToken(userAccessToken, scope, key).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, request);
    return request;
  }

  private async requestToken(assertion: string, scope: string, key: string): Promise<string> {
    const clientSecret = await this.options.secrets.get(this.options.clientSecretName);

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          client_id: this.options.clientId,
          client_secret: clientSecret,
          assertion,
          scope,
          requested_token_use: 'on_behalf_of',
        }),
      });
    } catch {
      throw new OboExchangeError('identity_provider_unreachable');
    }

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
    };

    if (!response.ok) {
      const code =
        typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error)
          ? body.error
          : 'unknown_error';
      throw new OboExchangeError(code, response.status);
    }
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new OboExchangeError('malformed_response', response.status);
    }

    this.remember(key, {
      token: body.access_token,
      expiresAt: this.now() + body.expires_in * 1000,
    });
    return body.access_token;
  }

  private remember(key: string, entry: CachedToken): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }
}
