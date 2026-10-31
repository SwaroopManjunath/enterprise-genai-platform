import { z } from 'zod';
import { InvalidRolesError } from '../errors';

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

const ROLE_PATTERN = /^[a-z0-9._:-]{1,64}$/;

/**
 * Parses `x-roles: Analyst, manager` into a clean list. Interim: Step 6 takes roles from validated
 * token claims, so a client can no longer assert its own roles.
 */
export function parseRoles(header: string | undefined): string[] {
  if (header === undefined || header.trim() === '') return [];

  const roles = [
    ...new Set(
      header
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (roles.length > 20) throw new InvalidRolesError('at most 20 roles');
  if (roles.some((r) => !ROLE_PATTERN.test(r))) {
    throw new InvalidRolesError('roles may contain letters, digits, ".", "_", ":" and "-"');
  }
  return roles;
}
