# ADR 0011: Agent orchestrator

- Status: Accepted
- Date: 2026-11-01

## Context

The assistant (ADR 0008) answers one question from documents. An agent goes further: it decides which
tool to call, reads the result, and decides again, in a loop. That loop is where real damage can happen.
A model that is wrong, confused or hijacked by text in a document can call the wrong tool, call a tool
forever, or send an email nobody asked for. Everything that was only a wrong answer becomes a wrong
action.

The design question is not how to make the model behave. It is what the platform guarantees when the
model does not.

## Decisions

### 1. The model proposes, the runner decides

The model's only power is to name a tool and arguments, or to give a final answer. Everything else is
enforced by code that does not read the model's reasoning:

- a **step budget** (default 6, a request can lower it, a hard ceiling of 10 caps it);
- a **run deadline**, a **per-call timeout** for the model and for each tool (a hung tool is aborted and
  the run continues), and at most **3 calls per step**;
- **loop detection**: the same tool with the same arguments (key order ignored) is not run a third time;
- two **malformed** model replies in a row end the run; one is forgiven and the model is told what was
  wrong.

Each of these ends the run with a named reason (`step_limit`, `timeout`, `loop_detected`, `model_error`)
rather than an error, so a limit doing its job is visible and countable.

### 2. A strict JSON protocol instead of native function calling

The gateway offers plain chat, so the model is asked to reply with exactly one JSON object: a list of
calls or a final answer. The parser accepts one code fence (models add one habitually) and rejects
everything else: prose around the JSON, both shapes at once, extra fields, arguments that are not an
object. A reply is never repaired by guessing, because guessing is where a hijacked model slips an action
through. Native function calling would be better once the gateway supports it; the model sits behind a
port, so the change stays local.

### 3. Permissions are enforced where the tool is reached

Each tool declares a risk class and the roles that may use it. The model is only told about the tools the
caller's roles allow, and a call to a tool outside that set is refused **exactly like an unknown tool**,
so the response does not reveal that a hidden tool exists. Arguments are validated against a strict
schema before anything runs, so a model that adds `"approved": true` gets an error, not an approval.

The agent has no access of its own. It calls retrieval **as the user** (on-behalf-of, ADR 0007), so
tenant and role trimming apply to everything it reads, and tools receive the user's tenant and identity
from the verified token, never from the model.

### 4. Every write waits for a person, and the approval is bound to what was shown

Tools are `read` or `write`. A write never runs from the loop: the run stops in `awaiting_approval` and
stores the **exact validated call**. Approving names only the call id; it carries no arguments, so what
runs is what the approver was shown, and the model cannot swap it afterwards.

- Only the **run's owner** can decide. Their own approval is the authorisation, so a colleague, an
  admin or an auditor cannot approve someone else's run (and an auditor cannot see the arguments).
- Deciding **claims** the run with a compare-and-swap on its revision before executing. Of two racing
  approvals exactly one gets past the save, and the second gets a 409. A write cannot run twice.
- Permissions are **re-checked at approval time**: a role lost while waiting stops the action.
- The wait does not count against the run deadline; the clock restarts when work resumes.
- Rejecting tells the model, which may carry on without the action.

Approval is a control for mistakes and hijacks, not a substitute for the tool's own rules: `send_email`
checks its recipient domain allowlist inside the tool, so a recipient the approver should not have
accepted is still refused.

### 5. Tool output is untrusted input

A ticket or document can contain text written to hijack the agent. Tool output is screened with the same
detector as retrieved sources (an instruction-like result never reaches the model, only a notice that it
was withheld), redacted like an answer (cards, IBANs, secrets), delimited as data so a stray closing tag
cannot end the block early, and cut to a fixed length. Errors from tools are split in two: a tool's own
message ("recipient not allowed") goes back to the model so it can adapt; anything unexpected becomes
"the tool failed" and the detail stays in logs.

One bug here is worth keeping as evidence. Output was first screened after `JSON.stringify`, which turns
a newline into a literal backslash-n; `Notes\nIGNORE ALL PREVIOUS INSTRUCTIONS` then read as `nIGNORE`
and scored zero. The demo against a poisoned document caught it, before any test did. Strings are now
screened one by one, with a regression test that fails without the fix.

### 6. An audit trail that proves what happened without storing what was said

Every run keeps append-only events: who acted (the user, or `agent`), which tool, the call id, a short
**digest of the arguments**, and the outcome. Raw arguments and raw tool output are not in the trail
(tests assert that), so the trail can be read by an auditor without becoming a copy of the data. The
approval summary shown to the owner is written by the tool, not the model.

### 7. State lives in a store, so a run can wait

A run can wait hours for a person, so nothing is held in process memory: transcript, queued calls,
pending approval and events are saved after every step behind a `RunStore` port with revision checks. Any
replica could resume a run. The adapter here is in-memory; Cosmos DB, partitioned by tenant, is the
target. The store is tenant-scoped, so another tenant's run id is simply "not found".

## Proof

The runner is tested with scripted models that misbehave on purpose (runaway, repeated calls, unknown and
forbidden tools, bad arguments, writes, double approvals, poisoned output, hanging tools, garbled
replies, leaks), and end to end through the real gateway, retrieval and token exchange. A poisoned
document is run against a model that does whatever it reads: with screening on it is withheld and nothing
is sent; with screening switched off the model asks to email the attacker, the approver can see exactly
that, and even an approval is refused by the allowlist. Breaking each safeguard on purpose (write
approval, step budget, loop detection, output screening, role re-check, owner check, the store's
compare-and-swap, tool visibility) fails or hangs the tests written for it.

## Consequences

- A run executes **inside the HTTP request** and returns when it finishes or pauses. That is simple and
  fits the 30 second default deadline, but long agents need a queue and a worker with polling.
- The store is **in-memory**: runs are lost on restart, and the compare-and-swap is only as strong as the
  real store's conditional write. Between claiming an approval and executing it, a crash loses the action
  (at most once, never twice). The idempotency key (`runId:callId`) is passed to tools so a safe retry is
  possible later.
- Approval is **owner only**, because continuing the run needs the owner's token for the next hops.
  Delegated approval (a manager approving on someone's behalf) needs a way to act without their token
  and is future work. There is no endpoint to cancel a run yet.
- Tools are **stand-ins**: an in-memory ticket system and mailer behind interfaces. The point here is the
  control around them, not the integrations.
- Limits bound a run, not a user: nothing yet caps concurrent runs per user or the total model cost of a
  run beyond the gateway's token quota. Cost tracking arrives with Step 11.
- Screening is the same pattern-based detector as ADR 0010, so it shares its limits (paraphrase, other
  languages). The approval gate and the tools' own rules are what bound the damage when it misses.
- Everything was exercised with scripted models. How a real model follows the protocol, and how often it
  trips the limits, is unmeasured, which the evaluation pipeline should cover.
