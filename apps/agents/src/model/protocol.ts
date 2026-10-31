import { z } from 'zod';

/** What the model decided to do next. Either ask for tools, or give the final answer. */
export type ModelStep =
  | {
      kind: 'calls';
      reason?: string;
      calls: { name: string; arguments: Record<string, unknown> }[];
    }
  | { kind: 'final'; answer: string };

/** The model's reply could not be understood. Never guessed at: the runner counts it and moves on. */
export class ModelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProtocolError';
  }
}

const MAX_REPLY_CHARS = 20_000;

const callsSchema = z
  .object({
    reason: z.string().max(500).optional(),
    calls: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            arguments: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const finalSchema = z.object({ final: z.string().min(1).max(8_000) }).strict();

/**
 * Strict on purpose. The model must answer in JSON; a reply that is not exactly one of the two
 * shapes is rejected, never repaired by guessing. A code fence around the JSON is the single
 * allowance, because models add one habitually. Anything else (prose around the JSON, both shapes
 * at once, extra fields) is a malformed reply.
 */
export function parseModelReply(raw: string): ModelStep {
  if (raw.length > MAX_REPLY_CHARS) throw new ModelProtocolError('reply too long');

  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(unfenced);
  } catch {
    throw new ModelProtocolError('reply is not valid JSON');
  }

  const final = finalSchema.safeParse(json);
  if (final.success) return { kind: 'final', answer: final.data.final };

  const calls = callsSchema.safeParse(json);
  if (calls.success) {
    return {
      kind: 'calls',
      ...(calls.data.reason !== undefined && { reason: calls.data.reason }),
      calls: calls.data.calls,
    };
  }

  throw new ModelProtocolError('reply matches neither a tool request nor a final answer');
}
