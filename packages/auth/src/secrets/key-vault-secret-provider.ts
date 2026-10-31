import {
  SECRET_NAME_PATTERN,
  SecretNotFoundError,
  SecretUnavailableError,
  type SecretProvider,
} from './secret-provider';

export interface KeyVaultOptions {
  /** e.g. https://my-vault.vault.azure.net */
  vaultUrl: string;
  /**
   * Returns an access token for https://vault.azure.net. In Azure this is the workload's managed
   * identity (via @azure/identity's DefaultAzureCredential), wired at deployment; injected here
   * so the provider has no hard dependency and is testable.
   */
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** How long a value is reused before re-reading it, so rotation is picked up. Default 5 min. */
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Azure Key Vault adapter (REST API 7.4) with a short cache so we do not call it per request. */
export class KeyVaultSecretProvider implements SecretProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: KeyVaultOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async get(name: string): Promise<string> {
    if (!SECRET_NAME_PATTERN.test(name)) throw new SecretNotFoundError(name);

    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    let response: Response;
    try {
      const token = await this.options.getToken();
      const url = `${this.options.vaultUrl.replace(/\/+$/, '')}/secrets/${name}?api-version=7.4`;
      response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new SecretUnavailableError(name);
    }

    if (response.status === 404) throw new SecretNotFoundError(name);
    if (!response.ok) throw new SecretUnavailableError(name);

    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== 'string') throw new SecretUnavailableError(name);

    this.cache.set(name, { value: body.value, expiresAt: this.now() + this.ttlMs });
    return body.value;
  }
}
