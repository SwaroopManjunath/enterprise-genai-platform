# @genai/auth

Shared authentication and authorization for every service: JWT validation, a secure-by-default
NestJS guard, on-behalf-of token exchange, secret providers and a local dev-token tool.

## Using it in a service

```ts
// app.module.ts: one line adds the verifier, the global guard and the 401/403 filter
@Module({ providers: [...authProviders()] })

// controller: the caller comes from the verified token, never from a header
@RequireRoles('prompt-admin')
@Post(':name/versions')
publish(@CurrentPrincipal() caller: AuthenticatedPrincipal, ...) {
  caller.tenantId; caller.userId; caller.roles;
}

// health checks opt out explicitly; everything else is protected by default
@Public() @Get('health')
```

## What gets checked

Signature against the issuer's keys, **RS256 only**, exact issuer, exact audience, mandatory expiry,
not-before (30 s skew allowed), and a well-formed tenant. Claims map the Entra ID way:

| Claim          | Becomes              |
| -------------- | -------------------- |
| `tid` (config) | `tenantId`           |
| `oid` or `sub` | `userId`             |
| `roles`        | `roles` (lowercased) |
| `scp`          | `scopes`             |

Every failure returns the same generic `401`; the reason is logged server-side only.

## Configuration

A service **refuses to start** without these (there is no auth-disabled mode):

| Variable                   | Meaning                                                   |
| -------------------------- | --------------------------------------------------------- |
| `AUTH_ISSUER`              | Exact `iss` tokens must carry                             |
| `AUTH_AUDIENCE`            | Exact `aud` tokens must carry                             |
| `AUTH_JWKS_URL`            | Identity provider's key endpoint (production), **or**     |
| `AUTH_JWKS_FILE`           | A local key file (development and tests); set exactly one |
| `AUTH_TENANT_CLAIM`        | Claim holding the tenant (default `tid`)                  |
| `AUTH_CLOCK_TOLERANCE_SEC` | Allowed clock skew (default 30)                           |

## Local development: real tokens, no bypass

```bash
# trust locally minted tokens (creates a gitignored key in ./.dev-keys on first use)
eval "$(npm run -s dev-token -w @genai/auth -- env)"

# mint a token for a user of a tenant, with roles
npm run -s dev-token -w @genai/auth -- mint --tenant acme-bank --user alice --roles manager,prompt-admin
```

The same verification code runs as in production; only the key source differs. The signing key is
for development only and is never needed by a deployed service.

## Also in this package

- **`EntraOboClient`**: exchanges a user's token for a downstream token (on-behalf-of), with a
  bounded cache and shared in-flight requests.
- **`EntraClientCredentialsClient`**: a service's token for itself (no user), for background work
  such as the ingestion pipeline writing to search. Cached per target API; the secret comes from the
  secret store by name.
- **`startDevTokenEndpoint`**: a local stand-in for Entra's token endpoint serving both the
  on-behalf-of and client-credentials grants (a client can be given app roles such as `indexer`), so
  both flows run over real HTTP in tests and demos.
- **`EnvSecretProvider` / `KeyVaultSecretProvider`**: read credentials from env vars locally or Azure
  Key Vault (managed identity) in Azure, with a short cache so rotation is picked up.
- **`TestIssuer`**: mints genuinely signed tokens (and attack fixtures: `alg: none`, key confusion,
  foreign keys) for tests.

## Design

See [ADR 0007](../../docs/adr/0007-authentication-and-authorization.md).

## Tests

```bash
npm test -w @genai/auth
```
