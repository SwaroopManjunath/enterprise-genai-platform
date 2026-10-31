import type { SecretProvider } from '@genai/auth';
import type { AzureDeploymentConfig, ResolvedAzureDeployment } from '../config/config';

/**
 * Looks up each deployment's API key from the secret store at startup, so keys live in Key Vault
 * and never in the repo, the image or the pipeline. A missing secret fails startup loudly, which
 * is better than the first user request discovering it.
 */
export async function resolveDeployments(
  deployments: readonly AzureDeploymentConfig[],
  secrets: SecretProvider,
): Promise<ResolvedAzureDeployment[]> {
  return Promise.all(
    deployments.map(async ({ apiKey, apiKeySecret, ...rest }) => ({
      ...rest,
      apiKey: apiKey ?? (await secrets.get(apiKeySecret as string)),
    })),
  );
}
