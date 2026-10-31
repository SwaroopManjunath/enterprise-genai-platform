import { z } from 'zod';

export const submitSchema = z.object({
  documentId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'letters, digits, ".", "_", ":" or "-" (max 128)'),
  filename: z.string().min(1).max(255),
  contentType: z.string().max(100).optional(),
  content: z.string().min(1),
});
