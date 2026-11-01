# Assistant first token

**Alerts:** `AssistantFirstTokenBurn` tiers. **SLO:** 95% of streamed answers start to arrive within
1.5 seconds.

The first token waits for retrieval, the prompt, the gateway admission checks and the model's first
chunk, and then for the StreamGuard to release its first piece: it holds back a short tail so a
leaking answer is never sent, which adds a little to every stream by design.

## Check

1. `genai.assistant.first_token` p95 on the dashboard, against "Request latency p95".
2. In a slow trace, find the gap between the request span's start and the model call's first byte.
3. If the model is the slow part, it is a provider problem: see [model fallback](model-fallback.md).
4. If only first token is slow but total latency is fine, suspect the holdback (`holdbackChars`) or a
   change to the guard.

## Do not

Remove the holdback to win back latency: it is what stops a leaked canary or instruction from reaching
the user before the answer is checked.
