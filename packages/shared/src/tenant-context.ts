import { randomUUID } from 'node:crypto';

/**
 * Identity of whoever a request is being served for. Every service receives this
 * and uses it for rate limits, quotas, data partitioning and audit logs.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string | undefined;
  readonly roles: readonly string[];
  readonly requestId: string;
}

export interface TenantContextInput {
  tenantId: string;
  userId?: string;
  roles?: readonly string[];
  requestId?: string;
}

// Lowercase slug: safe to use in cache keys, partition keys and log fields.
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class InvalidTenantError extends Error {
  constructor(tenantId: string) {
    super(`Invalid tenant id: "${tenantId}"`);
    this.name = 'InvalidTenantError';
  }
}

export function createTenantContext(input: TenantContextInput): TenantContext {
  if (!TENANT_ID_PATTERN.test(input.tenantId)) {
    throw new InvalidTenantError(input.tenantId);
  }
  return Object.freeze({
    tenantId: input.tenantId,
    userId: input.userId,
    roles: Object.freeze([...(input.roles ?? [])]),
    requestId: input.requestId ?? randomUUID(),
  });
}
