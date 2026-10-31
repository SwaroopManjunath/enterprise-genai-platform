import { SECRET_NAME_PATTERN, SecretNotFoundError, type SecretProvider } from './secret-provider';

/**
 * Local development adapter: secret `azure-openai-key` is read from env var
 * `SECRET_AZURE_OPENAI_KEY`. The `SECRET_` prefix keeps it from reading unrelated variables.
 */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(name: string): Promise<string> {
    if (!SECRET_NAME_PATTERN.test(name)) return Promise.reject(new SecretNotFoundError(name));

    const value = this.env[`SECRET_${name.toUpperCase().replace(/-/g, '_')}`];
    return value ? Promise.resolve(value) : Promise.reject(new SecretNotFoundError(name));
  }
}
