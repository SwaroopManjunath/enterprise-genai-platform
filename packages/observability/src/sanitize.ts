import { createHmac, randomBytes } from 'node:crypto';
import type { AttributeValue, Attributes } from '@opentelemetry/api';

/**
 * What telemetry may carry. The platform's whole design is that nobody sees what their role does
 * not allow, and telemetry is read by operators, stored for weeks and often sent to a third party,
 * so it must not become the side door. The rule is an allowlist, not a blocklist: a span attribute
 * is kept only if its key is a known one or under `genai.`, and its value looks like an identifier
 * or a number, never like prose. A question or an answer has spaces; a token is a long opaque
 * string; neither passes. This is defence in depth, not data-loss prevention: the first defence is
 * that the code never puts such things in, and tests check it end to end.
 */
const KNOWN_KEYS = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'peer.service',
  'error.type',
  'service',
]);
const IDENTIFIER = /^[A-Za-z0-9_.:\-/|,]{1,64}$/;
const JWT = /^[\w-]{10,}\.[\w-]{10,}\.[\w-]*$/;
const MAX_ARRAY = 16;

export function isSafeValue(value: unknown): value is AttributeValue {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return IDENTIFIER.test(value) && !JWT.test(value);
  if (Array.isArray(value))
    return value.length <= MAX_ARRAY && value.every((v) => isSafeValue(v) && typeof v !== 'object');
  return false;
}

export const isAllowedKey = (key: string): boolean =>
  KNOWN_KEYS.has(key) || key.startsWith('genai.');

/** Keeps only the attributes telemetry may carry. Everything else is dropped silently. */
export function safeAttributes(attributes: Record<string, unknown> | undefined): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (isAllowedKey(key) && isSafeValue(value)) out[key] = value;
  }
  return out;
}

/** Metric labels: a short fixed list, because every label multiplies what a metrics store holds. */
export const METRIC_LABELS = [
  'service',
  'route',
  'method',
  'status_class',
  'outcome',
  'cache',
  'kind',
  'action',
  'provider',
  'direction',
  'mode',
  'tool',
  'failure',
  'status',
  'tenant',
  'reason',
  'stage',
  'result',
] as const;

let salt = randomBytes(16).toString('hex');
export const setPseudonymSalt = (value: string | undefined): void => {
  salt = value ?? randomBytes(16).toString('hex');
};

/**
 * A stable stand-in for a tenant or user id: the same input always gives the same label, so
 * spend and errors can be followed per tenant, but the label cannot be turned back into the id,
 * and it differs between deployments.
 */
export const pseudonym = (id: string): string =>
  createHmac('sha256', salt).update(id).digest('hex').slice(0, 12);
