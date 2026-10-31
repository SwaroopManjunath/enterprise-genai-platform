import { z } from 'zod';

const versionNumber = z.coerce.number().int().positive();

export const createVersionSchema = z.object({
  template: z.string(),
  note: z.string().max(500).optional(),
});

export const activateSchema = z.object({ version: versionNumber });

export const experimentSchema = z.object({
  variants: z.array(z.object({ version: versionNumber, weight: z.number() })).max(10),
});

export const resolveSchema = z.object({
  variables: z.record(z.string()).default({}),
  subjectKey: z.string().min(1).max(200).optional(),
});

export const versionParamSchema = versionNumber;
