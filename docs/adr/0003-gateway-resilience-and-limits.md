# ADR 0003: Gateway resilience and per-tenant limits

- Status: Accepted
- Date: 2026-10-31

## Context

The LLM gateway fronts Azure OpenAI for many tenants. Upstream calls are slow, expensive and
occasionally fail (429 throttling, 5xx, regional incidents, a bad key on one deployment). One tenant
must not be able to exhaust capacity or budget for the others.

## Decisions

### 1. Retry first, then fall back, and classify errors

Every upstream failure is classified as `retryable` and/or `fallbackable`:

| Failure                       | Retry same deployment | Try next deployment |
| ----------------------------- | --------------------- | ------------------- |
| 429, 5xx, network, timeout    | yes                   | yes                 |
| 401, 403, 404                 | no                    | yes                 |
| 400, 422 (request is invalid) | no                    | no                  |

Retries use exponential backoff with **full jitter**. A `Retry-After` longer than our max delay
stops retrying and moves on to the next deployment rather than stalling the caller.

**Why not retry everything, or fall back on everything?** A malformed prompt fails identically on
every deployment, so retrying or falling back only adds latency and burns quota. A misconfigured
key will never succeed on retry, but another deployment might.

### 2. Token bucket for request rate, daily token quota for cost

- **Rate limit:** token bucket per tenant. Alternatives: fixed window (allows 2x bursts at window
  edges), sliding log (exact but memory-heavy). Token bucket allows small bursts and is O(1).
- **Quota:** tokens per UTC day, not requests, because spend scales with tokens.
- Quota is **checked before** and **recorded after** the call, since the true token count is only
  known afterwards. A tenant can overshoot by its in-flight requests. Reserving an estimate up
  front is tighter but needs refunds on failure; we accept the small overshoot for simplicity.

### 3. In-memory state behind interfaces

`RateLimiter` and `TokenQuota` are interfaces with in-memory implementations. This is correct for
one replica. Running several replicas requires a shared store (Redis) so limits are global; the
interfaces make that a drop-in replacement. Cheap local checks run before any upstream call.

## Consequences

- Deterministic, tested failure behaviour (see `retry.spec.ts`, `llm-router.spec.ts`, e2e tests).
- Limits are per replica until the Redis implementation lands (tracked in the roadmap).
- No circuit breaker yet: during a long outage each request still pays for retries on the dead
  primary before falling back. Adding one is a candidate follow-up if latency data shows it.
