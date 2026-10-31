import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TestIssuer } from './test-issuer';

export interface DevIssuer {
  issuer: TestIssuer;
  /** Path to the public key set; point a service's AUTH_JWKS_FILE at it. */
  jwksPath: string;
}

/**
 * Loads (or creates on first use) a local signing key under `dir`, so tokens minted today still
 * verify after a restart. Development only: the directory is gitignored, the private key is
 * written owner-readable only, and production services never see a private key at all.
 */
export function loadOrCreateDevIssuer(dir: string): DevIssuer {
  const root = resolve(dir);
  const privatePath = join(root, 'private.pem');
  const jwksPath = join(root, 'jwks.json');

  if (existsSync(privatePath)) {
    const issuer = TestIssuer.fromPrivateKeyPem(readFileSync(privatePath, 'utf8'));
    writeFileSync(jwksPath, JSON.stringify(issuer.jwks(), null, 2));
    return { issuer, jwksPath };
  }

  mkdirSync(root, { recursive: true });
  const issuer = new TestIssuer(undefined, undefined, undefined, 'dev-key-1');
  writeFileSync(privatePath, issuer.privateKeyPem(), { mode: 0o600 });
  chmodSync(privatePath, 0o600);
  writeFileSync(jwksPath, JSON.stringify(issuer.jwks(), null, 2));
  return { issuer, jwksPath };
}

/** The shell exports a service needs to trust tokens from this dev issuer. */
export function devEnvironment({ issuer, jwksPath }: DevIssuer): Record<string, string> {
  return {
    AUTH_ISSUER: issuer.issuer,
    AUTH_AUDIENCE: issuer.audience,
    AUTH_JWKS_FILE: jwksPath,
  };
}
