# ADR 0007: Authentication and authorization

- Status: Accepted
- Date: 2026-10-31

## Context

Until now every service trusted `x-tenant-id` and `x-roles` headers. That was an explicit placeholder,
and it meant the access trimming built in the retrieval service was only as strong as the caller's
honesty: anyone could send `x-roles: manager`. For an enterprise assistant, "the AI only sees what the
user may see" must hold even against a malicious caller.

## Decisions

### 1. Validate JWTs locally against the identity provider's published keys

Each service verifies the bearer token itself (signature against the provider's JWKS, then claims),
instead of calling the provider on every request.

|              | Local JWT validation                     | Token introspection per request |
| ------------ | ---------------------------------------- | ------------------------------- |
| Latency      | None added                               | A network call on every request |
| Availability | Survives a provider blip (keys cached)   | Provider outage becomes ours    |
| Revocation   | Effective only at token expiry (~1 hour) | Immediate                       |

We accept the revocation delay and rely on short-lived access tokens. Keys are fetched from the
JWKS URL, cached, and refetched on an unknown key id (with a cooldown so unknown ids cannot hammer
the provider), so signing-key rotation needs no restart. A test proves rotation is picked up and
that an unreachable key endpoint fails closed.

### 2. Use a library, pin the algorithm, require the claims

Token verification uses `jose`; nothing cryptographic is hand-rolled. We accept **RS256 only**
(what Entra ID uses), which blocks `alg: none` and the HS256 key-confusion attack (signing with the
public key as an HMAC secret). Issuer and audience must match exactly, `exp` is mandatory, and a
30 second clock tolerance covers skew. Tests include each of these attacks, a tampered payload and a
token signed by a foreign key that reuses a valid key id.

### 3. Identity comes only from the verified token

Tenant, user and roles are read from claims (`tid`, `oid`/`sub`, `roles`) and attached to the
request by a guard. The header-based code is **deleted**, not left dormant, and tests send spoofed
`x-tenant-id`, `x-roles` and `x-user-id` headers to prove they are ignored. The audit trail
therefore records who really acted.

### 4. Secure by default, and no "auth off" switch

- The guard is registered globally: a route is protected unless explicitly marked `@Public()`
  (only `/health`). Forgetting a decorator fails closed. A test covers an unannotated route.
- There is no auth-disabled mode and no default issuer. A service with missing auth settings
  refuses to start. Local development uses real signed tokens (below) instead of a bypass, so the
  development path and the production path are the same code.

### 5. One generic 401; reasons stay in the logs

Every failure (expired, wrong audience, forged signature, malformed) returns the same body with
`WWW-Authenticate: Bearer`, so an attacker cannot tell which check to work around. The specific
reason is logged server-side and the token is never put in a message. A test asserts all failure
kinds produce byte-identical responses.

### 6. Roles gate privileged operations (401 before 403)

Roles come from the token's app roles. Privileged operations need a role beyond membership:
`prompt-admin` (change what the AI is told), `ingestion-admin` (inspect and replay failed jobs) and
`indexer` (write to the search index: a service identity, not an end user). Authentication is
checked first, so an unauthenticated caller never learns which roles exist.

### 7. On-behalf-of token exchange for service-to-service calls

When the assistant calls retrieval for Alice, it exchanges Alice's token for a downstream token
(OAuth 2.0 JWT-bearer / on-behalf-of) instead of using its own powerful credentials. The downstream
service then validates a token that still names Alice, so her permissions apply across hops.
Exchanged tokens are cached (keyed by a hash, never the raw token) until shortly before expiry,
the cache is bounded, and concurrent identical exchanges share one request.

_Alternative:_ call downstream services with the calling service's own identity. Rejected: every
user would effectively inherit the assistant's access, defeating access trimming.

### 8. Secrets through a provider, not configuration

Credentials are read through a `SecretProvider`: environment variables locally, Azure Key Vault in
Azure (REST API, managed-identity token, short cache so rotation is picked up). Names are restricted
to a safe pattern so they cannot alter the request path, and errors never contain values. The
gateway's Azure API keys can be given as `apiKeySecret` names resolved at startup; a missing secret
fails startup instead of the first user request.

## Consequences

- A stolen token works until it expires (about an hour). Mitigation is short lifetimes now, and
  continuous access evaluation later if needed.
- Tenancy is read from one configurable claim (default `tid`) with a single configured issuer. A
  platform serving many customers' separate directories needs a per-tenant issuer allowlist or an
  identity layer that issues one `tenant` claim; that is future work.
- **Not verified against a real Entra ID tenant.** Everything is tested against locally generated
  RS256 keys, a local JWKS HTTP server and faked token endpoints. The wire formats follow the Entra
  documentation, but a real tenant run is still owed.
- The on-behalf-of client is built and tested but not yet called by a service; the assistant
  service (next step) is its first consumer.
- The Key Vault adapter is built and tested with a faked vault. Wiring it to a real managed
  identity (`@azure/identity`) happens with deployment.
- "Login" itself (acquiring a token) is the client application's job (MSAL in a front end); this
  platform validates tokens and does not issue them. The `dev-token` CLI stands in for it locally.
- Rate limits and quotas are still per tenant, not per user.
