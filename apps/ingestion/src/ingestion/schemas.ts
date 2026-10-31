import { z } from 'zod';

const label = z.string().min(1).max(64);

export const submitSchema = z.object({
  documentId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'letters, digits, ".", "_", ":" or "-" (max 128)'),
  filename: z.string().min(1).max(255),
  contentType: z.string().max(100).optional(),
  content: z.string().min(1),
  /** Roles allowed to read this document once it is searchable. Omit for the whole tenant. */
  allowedRoles: z.array(label).max(20).optional(),
  tags: z.array(label).max(20).optional(),
});
