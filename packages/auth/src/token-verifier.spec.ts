import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet } from 'jose';
import { loadAuthConfig } from './config';
import { AuthenticationError, type AuthFailureReason } from './principal';
import { TestIssuer } from './test-issuer';
import { TokenVerifier, createTokenVerifier } from './token-verifier';

const issuer = new TestIssuer();
const config = {
  issuer: issuer.issuer,
  audience: issuer.audience,
  tenantClaim: 'tid',
  clockToleranceSec: 30,
};
const verifier = new TokenVerifier(config, createLocalJWKSet(issuer.jwks() as never));

async function reasonOf(token: string): Promise<AuthFailureReason | 'accepted'> {
  try {
    await verifier.verify(token);
    return 'accepted';
  } catch (error) {
    if (error instanceof AuthenticationError) return error.reason;
    throw error;
  }
}

describe('TokenVerifier: accepting valid tokens', () => {
  it('maps claims to a principal', async () => {
    const token = issuer.mint({
      tenant: 'acme-bank',
      userId: 'user-42',
      roles: ['Manager', 'analyst', 'manager'],
      scopes: ['access_as_user', 'files.read'],
    });

    const principal = await verifier.verify(token);

    expect(principal).toMatchObject({
      tenantId: 'acme-bank',
      userId: 'user-42',
      roles: ['manager', 'analyst'],
      scopes: ['access_as_user', 'files.read'],
      accessToken: token,
    });
    expect(principal.tokenId).toBeDefined();
    expect(principal.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('lowercases the tenant, which Entra emits as an upper or mixed case GUID', async () => {
    const principal = await verifier.verify(
      issuer.mint({ tenant: '3F2504E0-4F89-11D3-9A0C-0305E82C3301' }),
    );
    expect(principal.tenantId).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('falls back to sub when oid is absent', async () => {
    const principal = await verifier.verify(
      issuer.mint({ tenant: 'acme', userId: 'sub-only', claims: { oid: undefined } }),
    );
    expect(principal.userId).toBe('sub-only');
  });

  it('gives no roles or scopes when the claims are missing', async () => {
    const principal = await verifier.verify(
      issuer.mint({ tenant: 'acme', claims: { roles: undefined, scp: undefined } }),
    );
    expect(principal.roles).toEqual([]);
    expect(principal.scopes).toEqual([]);
  });

  it('tolerates small clock skew', async () => {
    expect(await reasonOf(issuer.mint({ tenant: 'acme', expiresInSec: -10 }))).toBe('accepted');
    expect(await reasonOf(issuer.mint({ tenant: 'acme', notBeforeInSec: 10 }))).toBe('accepted');
  });

  it('can read the tenant from a custom claim', async () => {
    const custom = new TokenVerifier(
      { ...config, tenantClaim: 'customer' },
      createLocalJWKSet(issuer.jwks() as never),
    );
    const principal = await custom.verify(
      issuer.mint({ tenant: 'ignored', claims: { customer: 'globex' } }),
    );
    expect(principal.tenantId).toBe('globex');
  });
});

describe('TokenVerifier: rejecting bad tokens', () => {
  it.each<[string, () => string, AuthFailureReason]>([
    [
      'expired beyond tolerance',
      () => issuer.mint({ tenant: 'acme', expiresInSec: -120 }),
      'expired',
    ],
    [
      'not yet valid beyond tolerance',
      () => issuer.mint({ tenant: 'acme', notBeforeInSec: 600 }),
      'not_yet_valid',
    ],
    [
      'wrong issuer',
      () => issuer.mint({ tenant: 'acme', issuer: 'https://evil.example/v2.0' }),
      'invalid_claims',
    ],
    [
      'wrong audience',
      () => issuer.mint({ tenant: 'acme', audience: 'api://someone-else' }),
      'invalid_claims',
    ],
    [
      'no expiry claim',
      () => issuer.mint({ tenant: 'acme', claims: { exp: undefined } }),
      'invalid_claims',
    ],
    [
      'signed by a different key',
      () => issuer.forge.otherKey({ tenant: 'acme' }),
      'invalid_signature',
    ],
    ['alg none (unsigned)', () => issuer.forge.unsigned({ tenant: 'acme' }), 'invalid_signature'],
    [
      'HS256 using the public key as secret',
      () => issuer.forge.hmacWithPublicKey({ tenant: 'acme' }),
      'invalid_signature',
    ],
    [
      'missing tenant claim',
      () => issuer.mint({ tenant: 'acme', claims: { tid: undefined } }),
      'missing_tenant',
    ],
    [
      'tenant that is not a safe slug',
      () => issuer.mint({ tenant: 'acme/../globex' }),
      'invalid_tenant',
    ],
    [
      'no subject at all',
      () => issuer.mint({ tenant: 'acme', claims: { sub: undefined, oid: undefined } }),
      'invalid_claims',
    ],
    ['garbage', () => 'not.a.jwt', 'malformed'],
    ['empty', () => '', 'missing_token'],
  ])('%s', async (_label, makeToken, expected) => {
    expect(await reasonOf(makeToken())).toBe(expected);
  });

  it('a payload tampered after signing is rejected', async () => {
    const [header, , signature] = issuer.mint({ tenant: 'acme', roles: [] }).split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        iss: issuer.issuer,
        aud: issuer.audience,
        tid: 'acme',
        roles: ['admin'],
        sub: 'x',
        exp: 9999999999,
      }),
    ).toString('base64url');

    expect(await reasonOf(`${header}.${forgedPayload}.${signature}`)).toBe('invalid_signature');
  });

  it('never puts the token in an error message', async () => {
    const token = issuer.mint({ tenant: 'acme', expiresInSec: -999 });
    const error = (await verifier.verify(token).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain(token.split('.')[1] as string);
  });
});

describe('createTokenVerifier and loadAuthConfig', () => {
  it('builds a working verifier from a local JWKS file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'jwks-')), 'jwks.json');
    writeFileSync(file, JSON.stringify(issuer.jwks()));
    const fromFile = createTokenVerifier(
      loadAuthConfig({
        AUTH_ISSUER: issuer.issuer,
        AUTH_AUDIENCE: issuer.audience,
        AUTH_JWKS_FILE: file,
      }),
    );

    expect((await fromFile.verify(issuer.mint({ tenant: 'acme' }))).tenantId).toBe('acme');
  });

  it('requires an issuer, audience and exactly one key source', () => {
    const base = { AUTH_ISSUER: 'iss', AUTH_AUDIENCE: 'aud' };
    expect(() => loadAuthConfig({})).toThrow(/Invalid auth configuration/);
    expect(() => loadAuthConfig(base)).toThrow(/exactly one of AUTH_JWKS_URL or AUTH_JWKS_FILE/);
    expect(() =>
      loadAuthConfig({ ...base, AUTH_JWKS_URL: 'https://x.test/keys', AUTH_JWKS_FILE: 'k.json' }),
    ).toThrow(/exactly one/);
    expect(loadAuthConfig({ ...base, AUTH_JWKS_URL: 'https://x.test/keys' })).toMatchObject({
      tenantClaim: 'tid',
      clockToleranceSec: 30,
    });
  });
});
