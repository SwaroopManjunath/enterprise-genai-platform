import type { SecretProvider } from '../secrets/secret-provider';

/**
 * Gets a token for a service acting **as itself** (no user), for background work such as the
 * ingestion pipeline writing to the search index. Contrast with the on-behalf-of flow, where a
 * service acts as a user and the token still names that user.
 */
export interface AppTokenClient {
  getToken(scope: string): Promise<string>;
}

export const APP_TOKEN_CLIENT = Symbol('APP_TOKEN_CLIENT');

/** The identity provider refused to issue a service token. `code` is its error code. */
export class ClientCredentialsError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Client-credentials token request failed: ${code}`);
    this.name = 'ClientCredentialsError';
  }
}

export interface EntraClientCredentialsOptions {
  /** e.g. https://login.microsoftonline.com/<directory-tenant>/oauth2/v2.0/token */
  tokenEndpoint: string;
  clientId: string;
  /** Name of this service's client secret in the SecretProvider (Key Vault). */
  clientSecretName: string;
  secrets: SecretProvider;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Reuse a token until it has this many seconds left. Default 60. */
  refreshSkewSec?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Microsoft Entra ID client-credentials flow, cached per target API. */
export class EntraClientCredentialsClient implements AppTokenClient {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;

  constructor(private readonly options: EntraClientCredentialsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = (options.refreshSkewSec ?? 60) * 1000;
  }

  async getToken(scope: string): Promise<string> {
    const cached = this.cache.get(scope);
    if (cached && cached.expiresAt - this.refreshSkewMs > this.now()) return cached.token;

    // Concurrent callers for the same API share one request instead of stampeding the provider.
    const pending = this.inFlight.get(scope);
    if (pending) return pending;

    const request = this.requestToken(scope).finally(() => this.inFlight.delete(scope));
    this.inFlight.set(scope, request);
    return request;
  }

  private async requestToken(scope: string): Promise<string> {
    const clientSecret = await this.options.secrets.get(this.options.clientSecretName);

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: clientSecret,
          scope,
        }),
      });
    } catch {
      throw new ClientCredentialsError('identity_provider_unreachable');
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
      throw new ClientCredentialsError(code, response.status);
    }
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new ClientCredentialsError('malformed_response', response.status);
    }

    this.cache.set(scope, {
      token: body.access_token,
      expiresAt: this.now() + body.expires_in * 1000,
    });
    return body.access_token;
  }
}
