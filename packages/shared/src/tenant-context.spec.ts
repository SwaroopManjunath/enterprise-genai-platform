import { createTenantContext, InvalidTenantError } from './tenant-context';

describe('createTenantContext', () => {
  it('builds an immutable context and generates a request id', () => {
    const ctx = createTenantContext({ tenantId: 'acme-bank', roles: ['analyst'] });

    expect(ctx.tenantId).toBe('acme-bank');
    expect(ctx.roles).toEqual(['analyst']);
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.roles)).toBe(true);
  });

  it('keeps a caller-supplied request id so traces stay correlated', () => {
    const ctx = createTenantContext({ tenantId: 'acme-bank', requestId: 'req-123' });
    expect(ctx.requestId).toBe('req-123');
  });

  it.each(['', 'A', 'Acme', 'acme bank', '-acme', 'acme/../other', 'a'.repeat(64)])(
    'rejects unsafe tenant id %p',
    (tenantId) => {
      expect(() => createTenantContext({ tenantId })).toThrow(InvalidTenantError);
    },
  );
});
