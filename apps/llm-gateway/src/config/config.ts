import { z } from 'zod';

const deploymentSchema = z.object({
  /** Label used in logs and responses, e.g. "aoai-westeurope". */
  name: z.string().min(1),
  endpoint: z.string().url(),
  deployment: z.string().min(1),
  apiKey: z.string().min(1),
  apiVersion: z.string().default('2024-10-21'),
});

export type AzureDeploymentConfig = z.infer<typeof deploymentSchema>;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /** "mock" runs without any cloud dependency; "azure" talks to Azure OpenAI. */
  LLM_PROVIDER: z.enum(['mock', 'azure']).default('mock'),
  /** JSON array of deployments, ordered by preference: first is primary, rest are fallbacks. */
  AZURE_OPENAI_DEPLOYMENTS: z.string().default('[]'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(200),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(5_000),
  DEFAULT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  DEFAULT_DAILY_TOKEN_QUOTA: z.coerce.number().int().positive().default(1_000_000),
});

export interface GatewayConfig {
  port: number;
  provider: 'mock' | 'azure';
  deployments: AzureDeploymentConfig[];
  upstreamTimeoutMs: number;
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  limits: { requestsPerMinute: number; dailyTokenQuota: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.parse(env);

  let rawDeployments: unknown;
  try {
    rawDeployments = JSON.parse(parsed.AZURE_OPENAI_DEPLOYMENTS);
  } catch {
    throw new Error('AZURE_OPENAI_DEPLOYMENTS must be valid JSON');
  }
  const deployments = z.array(deploymentSchema).parse(rawDeployments);

  if (parsed.LLM_PROVIDER === 'azure' && deployments.length === 0) {
    throw new Error('LLM_PROVIDER=azure requires at least one entry in AZURE_OPENAI_DEPLOYMENTS');
  }

  return {
    port: parsed.PORT,
    provider: parsed.LLM_PROVIDER,
    deployments,
    upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS,
    retry: {
      maxAttempts: parsed.RETRY_MAX_ATTEMPTS,
      baseDelayMs: parsed.RETRY_BASE_DELAY_MS,
      maxDelayMs: parsed.RETRY_MAX_DELAY_MS,
    },
    limits: {
      requestsPerMinute: parsed.DEFAULT_REQUESTS_PER_MINUTE,
      dailyTokenQuota: parsed.DEFAULT_DAILY_TOKEN_QUOTA,
    },
  };
}
