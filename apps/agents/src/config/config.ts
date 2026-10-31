import type { PiiType } from '@genai/guardrails';
import { z } from 'zod';

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3005),

    GATEWAY_URL: z.string().url().default('http://localhost:3000'),
    RETRIEVAL_URL: z.string().url().default('http://localhost:3003'),
    GATEWAY_SCOPE: z.string().min(1).default('api://gateway/.default'),
    RETRIEVAL_SCOPE: z.string().min(1).default('api://retrieval/.default'),

    /** The on-behalf-of exchange, so the agent calls other services as the user. */
    OBO_TOKEN_ENDPOINT: z.string().url(),
    OBO_CLIENT_ID: z.string().min(1),
    OBO_CLIENT_SECRET_NAME: z.string().min(1).default('agents-client-secret'),

    // Limits. The hard ceilings cannot be exceeded by a request, only the defaults can be lowered.
    DEFAULT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(6),
    HARD_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(10),
    RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    MAX_CALLS_PER_STEP: z.coerce.number().int().min(1).max(10).default(3),
    /** The same call (same tool, same arguments) this many times in one run means it is looping. */
    LOOP_REPEAT_LIMIT: z.coerce.number().int().min(2).default(3),
    MAX_TOOL_OUTPUT_CHARS: z.coerce.number().int().min(200).default(4_000),

    /** Where send_email may deliver. Enforced by the tool even after a human approves. */
    EMAIL_ALLOWED_DOMAINS: z.string().default('acme-bank.example').transform(list),

    GUARDRAILS_MODE: z.enum(['enforce', 'monitor']).default('enforce'),
    GUARDRAILS_OUTPUT_PII: z
      .string()
      .default('secret,card,iban')
      .transform(list)
      .pipe(z.array(z.enum(['secret', 'iban', 'card', 'email', 'phone']))),
  })
  .refine((e) => e.DEFAULT_MAX_STEPS <= e.HARD_MAX_STEPS, {
    message: 'DEFAULT_MAX_STEPS must not exceed HARD_MAX_STEPS',
    path: ['DEFAULT_MAX_STEPS'],
  });

export interface AgentLimits {
  defaultMaxSteps: number;
  hardMaxSteps: number;
  runTimeoutMs: number;
  toolTimeoutMs: number;
  modelTimeoutMs: number;
  maxCallsPerStep: number;
  loopRepeatLimit: number;
  maxToolOutputChars: number;
}

export interface AgentsConfig {
  port: number;
  gateway: { url: string; scope: string };
  retrieval: { url: string; scope: string };
  obo: { tokenEndpoint: string; clientId: string; clientSecretName: string };
  limits: AgentLimits;
  emailAllowedDomains: string[];
  guardrails: { mode: 'enforce' | 'monitor'; outputPii: PiiType[] };
}

export const AGENTS_CONFIG = Symbol('AGENTS_CONFIG');

/** Fails fast: without the on-behalf-of settings the agent cannot act as the user. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentsConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    gateway: { url: e.GATEWAY_URL, scope: e.GATEWAY_SCOPE },
    retrieval: { url: e.RETRIEVAL_URL, scope: e.RETRIEVAL_SCOPE },
    obo: {
      tokenEndpoint: e.OBO_TOKEN_ENDPOINT,
      clientId: e.OBO_CLIENT_ID,
      clientSecretName: e.OBO_CLIENT_SECRET_NAME,
    },
    limits: {
      defaultMaxSteps: e.DEFAULT_MAX_STEPS,
      hardMaxSteps: e.HARD_MAX_STEPS,
      runTimeoutMs: e.RUN_TIMEOUT_MS,
      toolTimeoutMs: e.TOOL_TIMEOUT_MS,
      modelTimeoutMs: e.MODEL_TIMEOUT_MS,
      maxCallsPerStep: e.MAX_CALLS_PER_STEP,
      loopRepeatLimit: e.LOOP_REPEAT_LIMIT,
      maxToolOutputChars: e.MAX_TOOL_OUTPUT_CHARS,
    },
    emailAllowedDomains: e.EMAIL_ALLOWED_DOMAINS,
    guardrails: { mode: e.GUARDRAILS_MODE, outputPii: e.GUARDRAILS_OUTPUT_PII },
  };
}
