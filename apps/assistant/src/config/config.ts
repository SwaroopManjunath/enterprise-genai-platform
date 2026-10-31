import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3004),

  // Downstream services. Defaults match the local ports each service uses.
  GATEWAY_URL: z.string().url().default('http://localhost:3000'),
  PROMPTS_URL: z.string().url().default('http://localhost:3001'),
  RETRIEVAL_URL: z.string().url().default('http://localhost:3003'),

  /** The API each downstream token is requested for (Entra: "api://<app>/.default"). */
  GATEWAY_SCOPE: z.string().min(1).default('api://gateway/.default'),
  PROMPTS_SCOPE: z.string().min(1).default('api://prompt-registry/.default'),
  RETRIEVAL_SCOPE: z.string().min(1).default('api://retrieval/.default'),

  /** Token endpoint used for the on-behalf-of exchange, and this service's identity there. */
  OBO_TOKEN_ENDPOINT: z.string().url(),
  OBO_CLIENT_ID: z.string().min(1),
  /** Name of this service's client secret in the secret store (never the secret itself). */
  OBO_CLIENT_SECRET_NAME: z.string().min(1).default('assistant-client-secret'),

  /** Prompt template looked up in the registry; a built-in default is used if it is absent. */
  PROMPT_NAME: z.string().min(1).default('rag-answer'),
  DOWNSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DEFAULT_TOP_K: z.coerce.number().int().min(1).max(8).default(4),
});

export interface DownstreamConfig {
  url: string;
  scope: string;
}

export interface AssistantConfig {
  port: number;
  gateway: DownstreamConfig;
  prompts: DownstreamConfig;
  retrieval: DownstreamConfig;
  obo: { tokenEndpoint: string; clientId: string; clientSecretName: string };
  promptName: string;
  downstreamTimeoutMs: number;
  defaultTopK: number;
}

export const ASSISTANT_CONFIG = Symbol('ASSISTANT_CONFIG');

/** Fails fast: without an OBO endpoint and client id the assistant cannot act as the user. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    gateway: { url: e.GATEWAY_URL, scope: e.GATEWAY_SCOPE },
    prompts: { url: e.PROMPTS_URL, scope: e.PROMPTS_SCOPE },
    retrieval: { url: e.RETRIEVAL_URL, scope: e.RETRIEVAL_SCOPE },
    obo: {
      tokenEndpoint: e.OBO_TOKEN_ENDPOINT,
      clientId: e.OBO_CLIENT_ID,
      clientSecretName: e.OBO_CLIENT_SECRET_NAME,
    },
    promptName: e.PROMPT_NAME,
    downstreamTimeoutMs: e.DOWNSTREAM_TIMEOUT_MS,
    defaultTopK: e.DEFAULT_TOP_K,
  };
}
