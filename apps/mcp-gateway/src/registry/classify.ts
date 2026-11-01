import { fingerprint } from '@genai/shared';
import type { Guardrails } from '@genai/guardrails';
import type { RawTool } from '../mcp/mcp-client';
import type { SchemaValidator } from '../mcp/schema-validator';
import type { ToolRecord } from '../domain/types';

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClassifyLimits {
  maxDescriptionChars: number;
  maxSchemaChars: number;
}

/** Every string anywhere in a schema: property descriptions, titles, enum values, defaults. */
function schemaStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 500 || depth > 12) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => schemaStrings(v, out, depth + 1));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      out.push(key);
      schemaStrings(v, out, depth + 1);
    }
  }
  return out;
}

/** The fingerprint a reviewer approves: the whole definition as the server sent it. */
export const definitionHash = (tool: RawTool): string =>
  fingerprint({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });

export interface Classified {
  /** Without status or policy: the registry decides those from the previous record. */
  record: Omit<ToolRecord, 'status' | 'policy'>;
  /** Empty when the definition is acceptable for review. */
  quarantineReasons: string[];
}

/**
 * Turns what a server says about a tool into a record, and decides whether the definition is fit
 * to be reviewed at all.
 *
 * A tool definition is text the model will read, written by a party we do not control, so it is
 * checked like any other untrusted text. "Tool poisoning" hides instructions in the description or
 * in a parameter's description, sometimes far down a long text, so a definition too long to review
 * in full is quarantined rather than approved on a truncated view.
 */
export function classifyTool(
  raw: RawTool,
  deps: { guardrails: Guardrails; validator: SchemaValidator },
  limits: ClassifyLimits,
): Classified {
  const reasons: string[] = [];
  const hash = definitionHash(raw);

  if (!SAFE_NAME.test(raw.name)) reasons.push('invalid_name');

  let inputSchema = raw.inputSchema;
  if (JSON.stringify(raw.inputSchema).length > limits.maxSchemaChars) {
    reasons.push('schema_too_large');
    inputSchema = { type: 'object' };
  } else if (!deps.validator.compiles(hash, raw.inputSchema)) {
    reasons.push('invalid_schema');
  }

  const texts = [raw.name, raw.description, ...schemaStrings(raw.inputSchema)];
  const screened = deps.guardrails.screenSources(texts.map((text) => ({ text })));
  if (screened.report.quarantined > 0) {
    reasons.push(...screened.report.signals.map((signal) => `injection:${signal}`));
  }

  // A reviewer must be able to read everything they approve, so nothing is cut: a description
  // too long to review is quarantined, and the stored text is only shortened to bound memory.
  let description = raw.description;
  if (description.length > limits.maxDescriptionChars) {
    reasons.push('description_too_long');
    description = `${description.slice(0, limits.maxDescriptionChars)}…`;
  }

  return {
    record: { name: raw.name.slice(0, 64), description, inputSchema, hash },
    quarantineReasons: reasons,
  };
}
