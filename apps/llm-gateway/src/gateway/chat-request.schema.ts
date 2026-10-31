import { z } from 'zod';
import type { ChatRequest } from '../llm/types';

export const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1).max(100_000),
      }),
    )
    .min(1)
    .max(200),
  maxTokens: z.number().int().positive().max(32_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export function parseChatRequest(body: unknown): ChatRequest {
  const parsed = chatRequestSchema.parse(body);
  return {
    messages: parsed.messages,
    ...(parsed.maxTokens !== undefined && { maxTokens: parsed.maxTokens }),
    ...(parsed.temperature !== undefined && { temperature: parsed.temperature }),
  };
}
