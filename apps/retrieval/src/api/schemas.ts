import { z } from 'zod';

const roleName = z.string().min(1).max(64);

export const upsertDocumentSchema = z
  .object({
    chunks: z
      .array(
        z.object({
          index: z.number().int().min(0),
          text: z.string().min(1).max(20_000),
          metadata: z.record(z.unknown()).optional(),
        }),
      )
      .min(1)
      .max(500),
    allowedRoles: z.array(roleName).max(20).optional(),
    tags: z.array(roleName).max(20).optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{16,128}$/, 'lowercase hex digest')
      .optional(),
  })
  .refine((doc) => new Set(doc.chunks.map((c) => c.index)).size === doc.chunks.length, {
    message: 'chunk indexes must be unique',
    path: ['chunks'],
  });

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  topK: z.number().int().min(1).max(20).default(5),
  mode: z.enum(['hybrid', 'keyword', 'vector']).default('hybrid'),
  rerank: z.boolean().default(true),
  filter: z
    .object({
      documentIds: z.array(z.string().min(1).max(128)).max(50).optional(),
      tags: z.array(roleName).max(20).optional(),
    })
    .optional(),
});

/** Document ids become part of chunk ids and index keys, so they get a strict shape. */
export const documentIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
