import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { TokenVerifier } from './token-verifier';

export interface MintOptions {
  tenant: string;
  userId?: string;
  roles?: string[];
  scopes?: string[];
  /** Overrides, for building deliberately bad tokens in tests. */
  issuer?: string;
  audience?: string;
  /** Seconds from now until expiry; negative means already expired. Default 3600. */
  expiresInSec?: number;
  /** Seconds from now until the token becomes valid; positive means not yet valid. */
  notBeforeInSec?: number;
  /** Extra or replacement claims, merged last. Use `undefined` to drop one. */
  claims?: Record<string, unknown>;
}

const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/**
 * Local stand-in for Entra ID: generates an RSA key pair and mints genuinely signed RS256 tokens
 * with Entra-style claims (`tid`, `oid`, `roles`, `scp`). Used by tests and the dev-token CLI so
 * the real verification path (signature, issuer, audience, expiry) runs everywhere without a cloud
 * tenant. It is a development tool: production services only ever hold the public keys.
 */
export class TestIssuer {
  readonly kid: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    readonly issuer = 'https://login.test.local/v2.0',
    readonly audience = 'api://genai-platform',
    keyPair?: { privateKey: KeyObject; publicKey: KeyObject },
    kid = 'test-key-1',
  ) {
    const pair = keyPair ?? generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.kid = kid;
  }

  /** Rebuilds an issuer from a saved private key, so local tokens stay valid across restarts. */
  static fromPrivateKeyPem(
    pem: string,
    issuer?: string,
    audience?: string,
    kid = 'dev-key-1',
  ): TestIssuer {
    const privateKey = createPrivateKey(pem);
    return new TestIssuer(
      issuer,
      audience,
      { privateKey, publicKey: createPublicKey(privateKey) },
      kid,
    );
  }

  /** The private key as PEM, for the dev-token tool to save. Never needed in production. */
  privateKeyPem(): string {
    return this.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

  /** The public half as a JWKS document: what an identity provider publishes. */
  jwks(): { keys: Record<string, unknown>[] } {
    return {
      keys: [
        { ...this.publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'RS256', use: 'sig' },
      ],
    };
  }

  /** A verifier that trusts exactly this issuer's key: what tests plug into a service. */
  verifier(clockToleranceSec = 30): TokenVerifier {
    return new TokenVerifier(
      {
        issuer: this.issuer,
        audience: this.audience,
        tenantClaim: 'tid',
        clockToleranceSec,
      },
      createLocalJWKSet(this.jwks() as unknown as JSONWebKeySet),
    );
  }

  /** Synchronous so test helpers stay simple. Signs with RS256. */
  mint(options: MintOptions): string {
    const now = Math.floor(Date.now() / 1000);
    const userId = options.userId ?? 'user-1';
    const claims: Record<string, unknown> = {
      iss: options.issuer ?? this.issuer,
      aud: options.audience ?? this.audience,
      sub: userId,
      oid: userId,
      tid: options.tenant,
      roles: options.roles ?? [],
      scp: (options.scopes ?? ['access_as_user']).join(' '),
      jti: randomUUID(),
      iat: now,
      nbf: now + (options.notBeforeInSec ?? 0),
      exp: now + (options.expiresInSec ?? 3600),
      ...options.claims,
    };
    for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];

    const signingInput = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.kid }))}.${b64(JSON.stringify(claims))}`;
    return `${signingInput}.${b64(sign('RSA-SHA256', Buffer.from(signingInput), this.privateKey))}`;
  }

  /** Attack fixtures: tokens a correct verifier must reject. */
  forge = {
    /** `alg: none`, no signature: the classic "just trust the header" attack. */
    unsigned: (options: MintOptions): string => {
      const [, payload] = this.mint(options).split('.');
      return `${b64(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${payload}.`;
    },
    /** HS256 signed with our public key as the secret: the key-confusion attack. */
    hmacWithPublicKey: (options: MintOptions): string => {
      const [, payload] = this.mint(options).split('.');
      const input = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: this.kid }))}.${payload}`;
      const secret = this.publicKey.export({ type: 'spki', format: 'pem' });
      return `${input}.${b64(createHmac('sha256', secret).update(input).digest())}`;
    },
    /** Valid structure and claims, signed by a different key pair (same kid, so it is looked up). */
    otherKey: (options: MintOptions): string =>
      new TestIssuer(this.issuer, this.audience, undefined, this.kid).mint(options),
  };
}
