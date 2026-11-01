# Assistant availability

**Alerts:** `AssistantAvailability{Fast,Slow,Steady,Drip}Burn`. **SLO:** 99.5% of `POST /v1/ask` requests
do not end in a 5xx, over 30 days. A page means users are being dropped now; a ticket means a slow leak.

## First five minutes

1. Open the dashboard (`ops/grafana/genai-platform.json`), "Assistant availability: burn rate".
2. Which dependency is failing? Look at server errors per second by service. An assistant 5xx usually
   starts one hop down: `retrieval`, `prompt-registry` or `llm-gateway`. Those failures arrive as
   `DownstreamError` and surface as 502, 503 or 504.
3. Take a failing request's `x-trace-id` (every response carries one) and open the trace. The red client
   span is the dependency that failed; its `error.type` says `http`, `timeout` or `unreachable`.
4. Look at the logs for the same `traceId`. Log lines are JSON with `traceId` and `spanId`.

## Likely causes and what to do

| Sign                                                  | Cause                     | Action                                                         |
| ----------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| Red span on `llm-gateway`, `error.type=http`, 429/503 | Model throttled or down   | See [model fallback](model-fallback.md)                        |
| Red span on `retrieval` or `prompt-registry`          | That service is unhealthy | Restart or roll back it; the assistant has no other source     |
| `timeout` on every dependency at once                 | Network or node pressure  | Check the node and its saturation before touching the services |
| 5xx started right after a deploy                      | Bad release               | Roll back, then investigate                                    |
| 5xx only for one `route`                              | A bug on that path        | Roll back; add a test that reproduces it                       |

## Do not

- Turn guardrails to `monitor` to "get traffic through". A 5xx is not a guardrail decision (those are
  4xx and counted as `blocked`), and it removes protection while hiding the real fault.

## Afterwards

Write down what happened, what the budget cost (dashboard: "budget left"), and what would have caught it
sooner. If a single dependency caused it, ask whether the assistant should degrade instead of failing.
