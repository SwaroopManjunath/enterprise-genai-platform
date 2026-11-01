import { z } from 'zod';

const deploymentSchema = z
  .object({
    /** Label used in logs and responses, e.g. "aoai-westeurope". */
    name: z.string().min(1),
    endpoint: z.string().url(),
    deployment: z.string().min(1),
    /** Inline key: local experiments only. Prefer `apiKeySecret`. */
    apiKey: z.string().min(1).optional(),
    /** Name of the key in the secret store (Key Vault in Azure); resolved at startup. */
    apiKeySecret: z.string().min(1).optional(),
    apiVersion: z.string().default('2024-10-21'),
  })
  .refine((d) => Boolean(d.apiKey) !== Boolean(d.apiKeySecret), {
    message: 'set exactly one of apiKey or apiKeySecret',
  });

const priceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});

export type AzureDeploymentConfig = z.infer<typeof deploymentSchema>;

/** A deployment whose credential has been looked up, ready to call. */
export type ResolvedAzureDeployment = Omit<AzureDeploymentConfig, 'apiKey' | 'apiKeySecret'> & {
  apiKey: string;
};

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * "mock" echoes; "mock-grounded" is a deterministic stand-in for a model that answers from
   * numbered sources and cites them (for running the whole assistant path locally);
   * "azure" talks to Azure OpenAI.
   */
  LLM_PROVIDER: z.enum(['mock', 'mock-grounded', 'azure']).default('mock'),
  /** JSON array of deployments, ordered by preference: first is primary, rest are fallbacks. */
  AZURE_OPENAI_DEPLOYMENTS: z.string().default('[]'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(200),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(5_000),
  DEFAULT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  DEFAULT_DAILY_TOKEN_QUOTA: z.coerce.number().int().positive().default(1_000_000),
  /**
   * JSON object: deployment label -> `{ inputPerMTok, outputPerMTok }` in US dollars per million
   * tokens. A deployment missing here is served but reported as unpriced.
   */
  MODEL_PRICES: z.string().default('{}'),
  /** Optional daily spend cap per tenant, in US dollars. Unset means no cap beyond the token quota. */
  DAILY_COST_BUDGET_USD: z.coerce.number().positive().optional(),
});

export interface GatewayConfig {
  port: number;
  provider: 'mock' | 'mock-grounded' | 'azure';
  deployments: AzureDeploymentConfig[];
  upstreamTimeoutMs: number;
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  limits: { requestsPerMinute: number; dailyTokenQuota: number };
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  /** Daily spend cap per tenant in US dollars, when one is set. */
  dailyCostBudgetUsd?: number;
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

  let rawPrices: unknown;
  try {
    rawPrices = JSON.parse(parsed.MODEL_PRICES);
  } catch {
    throw new Error('MODEL_PRICES must be valid JSON');
  }
  const prices = z.record(z.string(), priceSchema).parse(rawPrices);

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
    prices,
    ...(parsed.DAILY_COST_BUDGET_USD !== undefined && {
      dailyCostBudgetUsd: parsed.DAILY_COST_BUDGET_USD,
    }),
  };
}
