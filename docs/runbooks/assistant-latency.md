# Assistant latency

**Alerts:** `AssistantLatency{Fast,Slow,Steady,Drip}Burn`. **SLO:** 95% of complete answers (`POST /v1/ask`)
finish within 5 seconds. Streaming answers are covered by [first token](assistant-first-token.md).

## First five minutes

1. Dashboard: "Request latency p95, by service". Which service moved first?
2. Open a slow trace (filter on the `assistant` service, longest first). The widest child span is the
   answer: retrieval, the model call, or the prompt registry.
3. `timings` in the answer body split the time into `retrievalMs` and `modelMs`, so a user's report
   with a request id is enough to tell which side was slow.

## Likely causes and what to do

| The wide span is   | Cause                                           | Action                                                               |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| `POST llm-gateway` | Model slow, or retries and fallback adding time | Check [model fallback](model-fallback.md); check token counts        |
| `POST retrieval`   | Large index, reranking, cold embedder           | Check results per search; check whether `rerank` is on for all calls |
| none, all thin     | The assistant itself (CPU, event loop)          | Check CPU and the number of replicas                                 |

A change in prompt size shows as more `genai.tokens.total` on the request spans and more time in the
model call: check whether a prompt version changed (`genai.prompt.version`).

## Afterwards

If the answer cache is off, consider `CACHE_MODE=shadow` to measure what it would save before serving
from it (see ADR 0013).
