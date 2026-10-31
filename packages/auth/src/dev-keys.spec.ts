import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenVerifier } from './token-verifier';
import { loadAuthConfig } from './config';
import { devEnvironment, loadOrCreateDevIssuer } from './dev-keys';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'devkeys-')), '.dev-keys');

describe('loadOrCreateDevIssuer', () => {
  it('creates a key, a JWKS file, and a verifier config that accepts the minted tokens', async () => {
    const dev = loadOrCreateDevIssuer(tmp());
    const verifier = createTokenVerifier(loadAuthConfig(devEnvironment(dev)));

    const principal = await verifier.verify(
      dev.issuer.mint({ tenant: 'acme-bank', userId: 'alice', roles: ['manager'] }),
    );

    expect(principal).toMatchObject({ tenantId: 'acme-bank', userId: 'alice', roles: ['manager'] });
  });

  it('writes the private key readable by the owner only', () => {
    const dir = tmp();
    loadOrCreateDevIssuer(dir);
    expect(statSync(join(dir, 'private.pem')).mode & 0o777).toBe(0o600);
  });

  it('reuses the same key on the next run, so earlier tokens stay valid', async () => {
    const dir = tmp();
    const first = loadOrCreateDevIssuer(dir);
    const token = first.issuer.mint({ tenant: 'acme' });

    const second = loadOrCreateDevIssuer(dir);
    const verifier = createTokenVerifier(loadAuthConfig(devEnvironment(second)));

    expect((await verifier.verify(token)).tenantId).toBe('acme');
  });
});
