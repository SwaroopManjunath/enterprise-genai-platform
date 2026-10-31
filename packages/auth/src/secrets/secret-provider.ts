/**
 * Where services get credentials (API keys, client secrets) from, instead of reading them from
 * configuration files. Locally that is environment variables; in Azure it is Key Vault, reached
 * with the workload's managed identity, so no secret ever lives in the repo, image or pipeline.
 */
export interface SecretProvider {
  get(name: string): Promise<string>;
}

export const SECRET_PROVIDER = Symbol('SECRET_PROVIDER');

export class SecretNotFoundError extends Error {
  constructor(readonly secretName: string) {
    super(`Secret "${secretName}" not found`);
    this.name = 'SecretNotFoundError';
  }
}

/** The store could not be reached or refused us. Retryable, unlike a missing secret. */
export class SecretUnavailableError extends Error {
  constructor(readonly secretName: string) {
    super(`Secret store unavailable while reading "${secretName}"`);
    this.name = 'SecretUnavailableError';
  }
}

/** Secret names are labels. They are never allowed to carry slashes or other path characters. */
export const SECRET_NAME_PATTERN = /^[0-9a-zA-Z-]{1,127}$/;
