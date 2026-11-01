import { z } from 'zod';

const serverId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, 'lowercase letters, digits and dashes');
const roleName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

export const registerSchema = z
  .object({
    id: serverId,
    name: z.string().trim().min(1).max(80),
    url: z.string().max(2_000),
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z
        .object({
          kind: z.literal('obo'),
          scope: z.string().regex(/^[A-Za-z0-9:/._-]{1,200}\/\.default$/),
        })
        .strict(),
      z
        .object({
          kind: z.literal('secret'),
          secretName: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
        })
        .strict(),
    ]),
  })
  .strict();

export const policySchema = z
  .object({
    /** Proves the admin looked at the definition now on record. */
    reviewedHash: z.string().regex(/^[0-9a-f]{64}$/),
    enabled: z.boolean(),
    allowedRoles: z.array(roleName).max(20),
    risk: z.enum(['read', 'write']),
  })
  .strict();

export const stateSchema = z.object({ enabled: z.boolean() }).strict();

export const callSchema = z
  .object({
    server: serverId,
    tool: z.string().min(1).max(64),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((c) => JSON.stringify(c.arguments).length <= 50_000, {
    message: 'arguments are too large',
    path: ['arguments'],
  });

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  server: z.string().max(40).optional(),
  userId: z.string().max(128).optional(),
  action: z
    .enum([
      'server_registered',
      'server_refreshed',
      'server_removed',
      'server_state_changed',
      'policy_changed',
      'tool_call',
    ])
    .optional(),
  outcome: z
    .enum([
      'ok',
      'tool_error',
      'denied',
      'not_found',
      'invalid_arguments',
      'rate_limited',
      'tool_changed',
      'upstream_error',
    ])
    .optional(),
});
