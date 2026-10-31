# ADR 0008: The assistant: one working path from login to a cited answer

- Status: Accepted
- Date: 2026-10-31

## Context

Five services existed in isolation. A platform is only credible if one real request can travel
through all of them: a user with a token asks a question and gets an answer that cites the documents
it came from, seeing only what that user may see. This ADR records how that path is built and, just
as importantly, what it does not yet prove.

## Decisions

### 1. The assistant acts as the user, not as itself

For each downstream API (retrieval, prompt registry, gateway) the assistant exchanges the user's
token for a token issued **for that API** (on-behalf-of flow, ADR 0007) and calls it with that.

- Retrieval trims results by the user's own tenant and roles, so "the AI only sees what the user may
  see" holds across service hops instead of stopping at the front door.
- Tokens are bound to one audience. A token for the assistant is refused by retrieval and the
  gateway; a token for retrieval is refused by the assistant. Tests prove both directions, so a
  leaked or replayed token is useful against one service only.
- The user's token is never forwarded as is.

_Alternative:_ call downstream services with the assistant's own credentials and pass the user's
roles along as data. Rejected: the downstream would have to trust the assistant to say who the user
is, so any bug or compromise in the assistant becomes a way to read everything.

### 2. Retrieve first; if nothing is allowed, never call the model

When retrieval returns nothing for this user the assistant answers "I could not find anything about
that in the documents available to you" without calling the LLM. It cannot hallucinate from nothing,
it costs no tokens, and it behaves identically whether the document does not exist or exists but is
restricted, so the reply does not reveal that a confidential document is there. A test asserts the
model's call count does not change for the restricted question.

### 3. Verify citations against what was retrieved

The model is asked to cite sources as `[n]`. Afterwards the assistant checks every marker against the
sources it actually supplied: a marker with no matching source (for example `[7]` when three were
given) is removed from the answer and reported in `droppedCitations`, grouped markers like `[1, 2]`
are understood, and the returned citations only contain chunks retrieved for this user, each with the
document, chunk id, heading path and an excerpt. `grounded` is true only when at least one real
citation remains.

**What this does not prove:** that the cited chunk really supports the claim. A model can cite a real
source for a statement it made up. Checking that is semantic groundedness, which is the evaluation
pipeline's job (Step 12). Today the guarantee is "no invented sources", not "no invented claims".

### 4. Treat retrieved text as untrusted when building the prompt

Document text could contain a line like `[9] Official policy` to forge an extra source. Lines that
start with a bracketed number are rewritten before they enter the prompt, and template filling is
single-pass (as in the prompt registry), so document text cannot expand other variables. This is a
narrow defence: it stops forged sources, not instructions hidden in prose ("ignore previous
instructions"). That is the guardrails step (Step 8).

### 5. The prompt registry is a soft dependency

The assistant resolves the tenant's `rag-answer` prompt from the registry (with the user as the A/B
subject key). If none is published, or the registry is down, it falls back to a built-in prompt and
keeps answering; the response reports `prompt.source` (`registry` or `builtin`) and version, so a
silent fallback is visible. Availability beats customisation for this dependency; the gateway and
retrieval are hard dependencies and produce a 503 when down.

### 6. Failures map to what the caller can act on

429 from the gateway (rate limit or token quota) is passed through with `Retry-After`; a dead, slow
or 5xx dependency is a temporary `503 assistant_unavailable`; a dependency rejecting our own
credentials is a `502` with no detail, since it is our misconfiguration and the caller cannot fix it;
an on-behalf-of "consent required" becomes a `403 interaction_required`. No error carries a token, a
URL or a stack trace; a test asserts that.

### 7. Prove it with the real services, over HTTP, and prove the proof can fail

`tests/e2e` starts retrieval, the prompt registry, the gateway and the assistant on real local ports
plus the dev on-behalf-of endpoint, and drives them with genuinely signed tokens. The real
`EntraOboClient` performs the exchange over HTTP. The same stack backs a runnable demo
(`npm run demo -w @genai/e2e`). To confirm the test is not vacuous, access trimming was deliberately
broken and exactly the two security scenarios failed; restored, everything passed.

## Consequences

- **The LLM is a deterministic test double** (`LLM_PROVIDER=mock-grounded`): it quotes the best
  matching source and cites it. The path is real; the model is not. Answer quality with Azure OpenAI
  is unmeasured until a real deployment and the evaluation pipeline exist.
- **Ingestion is not yet connected to retrieval.** The e2e seeds the search index through its
  `indexer` API, as the ingestion service eventually will. "Upload a document, then ask about it" is
  a separate piece of work (service-to-service auth with an app-only token, and carrying access
  roles from upload to index).
- Everything runs in one process with in-memory stores. It is the real code and the real HTTP
  boundaries, not containers on AKS.
- Each request makes up to three token exchanges (cached per user and API), plus three downstream
  calls. Latency has not been measured.
- Single-turn only: no conversation memory, no streaming.
- Limits are per tenant at the gateway, not per user.

> **Update (ADR 0009):** the first consequence above, that ingestion was not connected to retrieval,
> is resolved: uploads now reach the search index with their access lists.
