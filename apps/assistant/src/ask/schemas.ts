import { z } from 'zod';

export const askSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(8).optional(),
  /** Ask for a freshly generated answer instead of one from the answer cache. */
  noCache: z.boolean().optional(),
  filter: z
    .object({
      documentIds: z.array(z.string().min(1).max(128)).max(50).optional(),
      tags: z.array(z.string().min(1).max(64)).max(20).optional(),
    })
    .optional(),
});
