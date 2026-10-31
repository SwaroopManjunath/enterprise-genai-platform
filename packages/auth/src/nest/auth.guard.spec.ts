import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TestIssuer } from '../test-issuer';
import { TOKEN_VERIFIER, authProviders } from './auth-providers';
import { CurrentPrincipal, Public, RequireRoles } from './decorators';
import type { AuthenticatedPrincipal } from '../principal';

@Controller()
class DemoController {
  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    const { accessToken: _hidden, ...safe } = principal;
    return safe;
  }

  @RequireRoles('Admin')
  @Get('admin')
  admin(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { by: principal.userId };
  }

  /** Forgot to think about auth: must still be protected. */
  @Get('forgotten')
  forgotten() {
    return { secret: true };
  }
}

@Module({ controllers: [DemoController], providers: authProviders() })
class DemoModule {}

describe('AuthGuard', () => {
  const issuer = new TestIssuer();
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DemoModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(issuer.verifier())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, authorization?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return authorization ? req.set('authorization', authorization) : req;
  };
  const bearer = (token: string) => `Bearer ${token}`;

  it('lets public routes through without a token', async () => {
    await get('/open').expect(200, { ok: true });
  });

  it('protects routes by default, even ones nobody thought about', async () => {
    await get('/forgotten').expect(401);
  });

  it('exposes the verified identity to the handler (and never the raw token)', async () => {
    const token = issuer.mint({ tenant: 'acme', userId: 'u-1', roles: ['analyst'] });

    const res = await get('/me', bearer(token)).expect(200);

    expect(res.body).toMatchObject({ tenantId: 'acme', userId: 'u-1', roles: ['analyst'] });
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('answers every failure with the same generic 401 and no detail', async () => {
    const bad: [string, string | undefined][] = [
      ['no header', undefined],
      ['wrong scheme', `Basic ${Buffer.from('a:b').toString('base64')}`],
      ['empty bearer', 'Bearer '],
      ['expired', bearer(issuer.mint({ tenant: 'acme', expiresInSec: -999 }))],
      ['wrong audience', bearer(issuer.mint({ tenant: 'acme', audience: 'api://other' }))],
      ['forged signature', bearer(issuer.forge.otherKey({ tenant: 'acme' }))],
      ['alg none', bearer(issuer.forge.unsigned({ tenant: 'acme' }))],
    ];

    const bodies = new Set<string>();
    for (const [, header] of bad) {
      const res = await get('/me', header).expect(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      bodies.add(JSON.stringify(res.body));
    }

    expect(bodies.size).toBe(1); // indistinguishable to the client
    expect([...bodies][0]).toBe(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Authentication required' } }),
    );
  });

  it('accepts the Bearer scheme case-insensitively', async () => {
    await get('/me', `bearer ${issuer.mint({ tenant: 'acme' })}`).expect(200);
  });

  it('returns 403 (not 401) when authenticated but missing a required role', async () => {
    const res = await get(
      '/admin',
      bearer(issuer.mint({ tenant: 'acme', roles: ['analyst'] })),
    ).expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('allows the role regardless of case', async () => {
    const token = issuer.mint({ tenant: 'acme', userId: 'boss', roles: ['ADMIN'] });
    await get('/admin', bearer(token)).expect(200, { by: 'boss' });
  });

  it('checks authentication before authorization', async () => {
    await get('/admin').expect(401);
  });
});
