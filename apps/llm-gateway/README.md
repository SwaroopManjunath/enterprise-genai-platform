# llm-gateway

One internal API in front of Azure OpenAI deployments. Services call the gateway, never the model
vendor directly, so limits, retries, fallback and (later) auth, caching and tracing live in one place.

## Request flow

```mermaid
flowchart TD
    A[POST /v1/chat/completions] --> B{valid tenant + body?}
    B -- no --> E1[400]
    B -- yes --> C{rate limit ok?}
    C -- no --> E2[429 + Retry-After]
    C -- yes --> D{daily token quota left?}
    D -- no --> E3[429 quota_exceeded]
    D -- yes --> G{daily cost budget left?}
    G -- no --> E5[429 budget_exceeded]
    G -- yes --> P[Primary deployment]
    P -- 429/5xx/timeout --> R[retry with backoff + jitter]
    R -- still failing --> F[Next deployment]
    F -- all failed --> E4[503]
    P -- ok --> OK[200 + usage + cost]
    F -- ok --> OK
```

## Run it locally (no cloud account needed)

```bash
npm install
npm run build
eval "$(npm run -s dev-token -w @genai/auth -- env)"   # trust locally minted dev tokens
PORT=3000 node apps/llm-gateway/dist/main.js
```

```bash
curl -s -X POST localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(npm run -s dev-token -w @genai/auth -- mint --tenant acme-bank)" \
  -d '{"messages":[{"role":"user","content":"What is RAG?"}]}'
```

The default `LLM_PROVIDER=mock` echoes your message. To use Azure OpenAI set `LLM_PROVIDER=azure`
and `AZURE_OPENAI_DEPLOYMENTS` (see [`.env.example`](.env.example)). Order matters: first entry is
the primary, the rest are fallbacks.

## API

`POST /v1/chat/completions` with `Authorization: Bearer <JWT>`. The tenant comes from the token's
verified claims (see [ADR 0007](../../docs/adr/0007-authentication-and-authorization.md)); there is
no tenant header to spoof. `GET /health` is public. Optional `x-request-id` is a tracing id only.

| Status | `error.code`                | Meaning                                      |
| ------ | --------------------------- | -------------------------------------------- |
| 200    |                             | Completion returned                          |
| 401    | `unauthorized`              | Missing, expired or invalid token            |
| 400    | `invalid_request`           | Body failed validation (`issues` lists them) |
| 400    | `upstream_rejected_request` | Model rejected the request itself            |
| 429    | `rate_limited`              | Too many requests; see `Retry-After`         |
| 429    | `quota_exceeded`            | Tenant's daily token budget is spent         |
| 429    | `budget_exceeded`           | Tenant's daily cost budget is spent          |
| 503    | `upstream_unavailable`      | Every configured deployment failed           |

## Cost

Every response carries `cost: { microUsd, priced }`: the token counts from the upstream, times the
deployment's price. Prices are dollars per million tokens in `MODEL_PRICES` (a JSON object keyed by
deployment name); tokens times price is already in micro-dollars, so every amount is an integer. A
deployment with no price is reported as `priced: false` and counted apart, never as free.

`GET /v1/usage?days=7` (role `cost-viewer`, own tenant only) returns today's spend, the budget and what
is left of it when `DAILY_COST_BUDGET_USD` is set, and per-day totals by deployment, including how many
requests were streamed, estimated or unpriced.

## Streaming

Add `"stream": true` to the request to receive server-sent events instead of one JSON body:

```text
event: delta
data: {"text":"Refunds take ","provider":"aoai-westeurope","fallbackUsed":false}

event: done
data: {"finishReason":"stop","usage":{...},"provider":"...","fallbackUsed":false,"cost":{...},"estimated":false}
```

Everything that can refuse the request (rate limit, quota, budget, every deployment down, a bad body)
is decided before the first byte, so those are still ordinary JSON errors with the usual status codes;
only a failure after the stream began is reported in-band, as an `error` event. Retry and fallback work
up to the first piece of text; a deployment that fails after that fails the stream instead of silently
starting a second answer. If the client hangs up the upstream call is stopped, and what was generated is
billed as an estimate (`estimated: true`, counted in `estimatedRequests`), because the deployment still
charged for it. A stream with no token counts from the upstream is estimated the same way.

## Design

See [ADR 0003](../../docs/adr/0003-gateway-resilience-and-limits.md) and
[ADR 0013](../../docs/adr/0013-cost-and-performance.md).

## Tests

```bash
npm test -w @genai/llm-gateway
```
