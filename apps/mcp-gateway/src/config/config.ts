import type { PiiType } from '@genai/guardrails';
import { z } from 'zod';

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3006),

  /** The on-behalf-of exchange, for servers that should see the calling user. */
  OBO_TOKEN_ENDPOINT: z.string().url(),
  OBO_CLIENT_ID: z.string().min(1),
  OBO_CLIENT_SECRET_NAME: z.string().min(1).default('mcp-gateway-client-secret'),

  /**
   * Hosts the gateway may reach even though they resolve to private addresses, and the only hosts
   * it will speak plain http to. Empty by default: public https only.
   */
  ALLOWED_HOSTS: z.string().default('').transform(list),

  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MAX_UPSTREAM_BYTES: z.coerce.number().int().min(1_000).default(1_000_000),
  MAX_RESULT_CHARS: z.coerce.number().int().min(200).default(8_000),
  MAX_SERVERS_PER_TENANT: z.coerce.number().int().positive().default(20),
  MAX_TOOLS_PER_SERVER: z.coerce.number().int().positive().default(100),
  MAX_DESCRIPTION_CHARS: z.coerce.number().int().min(50).default(500),
  MAX_SCHEMA_CHARS: z.coerce.number().int().min(200).default(10_000),
  /** How long a tool list is trusted. Past it, the next call re-reads it to catch a changed definition. */
  VERIFY_TTL_MS: z.coerce.number().int().min(0).default(60_000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

  GUARDRAILS_MODE: z.enum(['enforce', 'monitor']).default('enforce'),
  GUARDRAILS_OUTPUT_PII: z
    .string()
    .default('secret,card,iban')
    .transform(list)
    .pipe(z.array(z.enum(['secret', 'iban', 'card', 'email', 'phone']))),
});

export interface McpGatewayConfig {
  port: number;
  obo: { tokenEndpoint: string; clientId: string; clientSecretName: string };
  allowedHosts: string[];
  upstreamTimeoutMs: number;
  maxUpstreamBytes: number;
  maxResultChars: number;
  maxServersPerTenant: number;
  maxToolsPerServer: number;
  maxDescriptionChars: number;
  maxSchemaChars: number;
  verifyTtlMs: number;
  rateLimitPerMinute: number;
  guardrails: { mode: 'enforce' | 'monitor'; outputPii: PiiType[] };
}

export const MCP_GATEWAY_CONFIG = Symbol('MCP_GATEWAY_CONFIG');

/** Fails fast on anything missing or malformed, so a typo cannot silently weaken a control. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpGatewayConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    obo: {
      tokenEndpoint: e.OBO_TOKEN_ENDPOINT,
      clientId: e.OBO_CLIENT_ID,
      clientSecretName: e.OBO_CLIENT_SECRET_NAME,
    },
    allowedHosts: e.ALLOWED_HOSTS,
    upstreamTimeoutMs: e.UPSTREAM_TIMEOUT_MS,
    maxUpstreamBytes: e.MAX_UPSTREAM_BYTES,
    maxResultChars: e.MAX_RESULT_CHARS,
    maxServersPerTenant: e.MAX_SERVERS_PER_TENANT,
    maxToolsPerServer: e.MAX_TOOLS_PER_SERVER,
    maxDescriptionChars: e.MAX_DESCRIPTION_CHARS,
    maxSchemaChars: e.MAX_SCHEMA_CHARS,
    verifyTtlMs: e.VERIFY_TTL_MS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    guardrails: { mode: e.GUARDRAILS_MODE, outputPii: e.GUARDRAILS_OUTPUT_PII },
  };
}
