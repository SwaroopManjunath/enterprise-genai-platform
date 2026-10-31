# ADR 0004: Prompt registry design

- Status: Accepted
- Date: 2026-10-31

## Context

Prompts change the behaviour of every feature that uses them, often more than code does, yet they
are usually edited in place with no history. We need to change prompts safely: know what changed,
undo a bad change fast, and test a new prompt on part of the traffic before switching everyone.

## Decisions

### 1. Append-only versions, with a separate "active" pointer

Editing creates version N+1; existing versions are never modified. Which version is served is a
separate pointer. Publishing a draft therefore cannot change live behaviour; activation is an
explicit, audited step.

**Rollback is just moving the pointer back.** No data is deleted or rewritten, so it is instant and
safe, and the history records `{ kind: rollback, from, to, by, at }`.

_Alternative:_ mutable prompts with a changelog. Rejected: you cannot reliably restore what was
actually served at a given time, and a bad edit is live the moment it is saved.

### 2. Deterministic, stateless A/B assignment

Variant = hash(tenant, prompt, experiment start, subject) mapped onto the weights.

- **Sticky:** the same user keeps the same variant for the whole experiment, so conversations do
  not flip prompts mid-way and comparisons stay clean.
- **No stored assignment table:** works across restarts and replicas with nothing to keep in sync.
- **Reshuffles per experiment:** the start time is in the hash, so the same users are not always in
  variant B of every experiment.
- **No subject key means no experiment:** we serve the active version rather than random-per-request,
  because random assignment cannot be attributed to a user or conversation.

_Alternative:_ random choice per request. Rejected for the reasons above.

### 3. Logic-less templates, single-pass substitution

Only `{{name}}` placeholders; no expressions, loops or code, so a template cannot execute anything.
Substitution is single-pass, so a variable value containing `{{other}}` is inserted as plain text
and never expanded. This stops user input from reaching other variables (for example a system-only
instruction) through the template. Missing variables fail loudly and list every missing name.

### 4. Optimistic concurrency at the repository boundary

Each record carries a `revision`; a save succeeds only if the stored revision still matches. Two
editors racing get a `409 conflict` instead of one silently overwriting the other. This maps
directly onto Cosmos DB ETags when the in-memory adapter is replaced.

### 5. Storage behind a port, tenant as the key

`PromptRepository` is an interface; the in-memory adapter is for dev and tests. Everything is keyed
by tenant first, so a tenant can never read another tenant's prompts. For Cosmos DB the tenant id
becomes the partition key (decided per tenant, see roadmap).

## Consequences

- Safe, fast rollback and a full audit trail of who activated what.
- Experiment results still need to be measured: linking the resolved `version` to quality metrics
  is the job of the evaluation pipeline (Step 11).
- In-memory storage loses data on restart; a persistent adapter is required before production.
- Changing an experiment's weights mid-run moves some users between variants; stop and start a new
  experiment instead when a clean comparison matters.
