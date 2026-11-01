import { z } from 'zod';

export const startRunSchema = z
  .object({
    goal: z.string().trim().min(1).max(2000),
    maxSteps: z.number().int().min(1).max(20).optional(),
  })
  .strict();

/** A decision names the call and says yes or no. It carries no arguments: what runs is what was stored. */
export const decisionSchema = z
  .object({
    callId: z.string().regex(/^c\d{1,4}$/),
    decision: z.enum(['approve', 'reject']),
  })
  .strict();
