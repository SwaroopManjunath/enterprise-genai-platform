# ADR 0012: MCP gateway

- Status: Accepted
- Date: 2026-11-01

## Context

The agent (ADR 0011) can only use the tools we wrote into it. The Model Context Protocol (MCP) is the
common way to plug other systems in: a server publishes tools (a name, a description the model reads, an
input schema) and answers `tools/call`. Letting agents use arbitrary MCP servers is a different risk
from our own code. A tool definition is text a third party wrote that the model will read and obey. A
server can change that text after someone vetted it. Its address is supplied by an admin, so it can point
the platform at internal systems. Its results are more untrusted text. And once many tools exist, nobody
can say who used what.

The gateway is the one place where those risks are handled, so every agent (and any other client) gets
the same protections.

## Decisions

### 1. Nothing is callable until a person approves a specific definition

A server's tools are discovered when it is registered and start as `pending`. An admin approves each tool
for named roles and a risk class (`read` or `write`). The approval **pins the definition's hash** (SHA-256
of name, description and input schema) and must quote the hash the admin reviewed: if the definition
changed in between, the approval is refused (409), so an admin cannot approve something other than what
they looked at. Unknown, unapproved, disabled and not-permitted tools all answer the same 404, so a
caller learns nothing about tools they may not use.

### 2. A tool that changes is switched off until reviewed (rug-pull defence)

A server can return benign text during review and different text later. The tool list is re-read
whenever the cached copy is older than `VERIFY_TTL_MS` (default 60 seconds), before the call is made. A
tool whose hash no longer equals the pinned one becomes `changed` and stops working, the server is not
called, and only a caller who is permitted to use the tool is told why (409), because everyone else
learns nothing. If the list cannot be re-read the call **fails closed**. Re-approval needs a review of
the new definition. **Limit:** within the interval a change goes unnoticed, and a server whose
_behaviour_ changes while its definition does not cannot be detected by any of this.

### 3. Tool definitions are untrusted text, and a definition must be reviewable

The description and every string in the input schema (property descriptions, titles, enum values) pass
through the same injection screen as retrieved documents (ADR 0010). A hostile definition is
**quarantined** and cannot be approved. So are an unsafe tool name, an oversized or uncompilable schema
(a remote `$ref` is never fetched), and a description too long to read in full: truncating for display
would let an admin approve text they never saw, so it is refused instead.

### 4. Where the gateway may connect is a policy, not a convention

Server URLs are admin-supplied, which makes them a route to internal services and the cloud metadata
endpoint (SSRF). Only http and https are allowed, URL credentials are refused, and plain http and
private addresses are allowed only for hosts on an explicit allow list (empty in production). Every
address a name resolves to is checked **at connect time**, not just at registration, which closes DNS
rebinding, and IPv4-mapped IPv6 forms are unwrapped. Redirects are never followed, responses are capped
in size, and every request has a deadline.

### 5. Servers see the user, not the gateway

A server is registered with one of three credentials. `obo` exchanges the calling user's token for the
server's audience, so the server sees the actual user and applies its own access rules; the end-to-end
tests prove the CRM receives `sam`, not the gateway. `secret` uses one shared service credential from the
secret store, which gives every caller the same access upstream, so it is for servers where that is the
intent. `none` is for trusted internal servers.

### 6. Results are untrusted text too

Only text is passed on (other content types are replaced with a note naming what was omitted), cut to a
fixed length, screened for instructions aimed at the model (withheld if found) and redacted (cards,
IBANs, secrets). A server's own error message is never relayed. The agent screens again, so a result has
to get past two independent checks; the end-to-end test proves the second one holds when the first is
switched off.

### 7. Three separate roles, and a log nobody can edit

`mcp-admin` manages servers and approvals and cannot call tools; `mcp-user` lists and calls the tools
their roles allow; `mcp-auditor` reads the log and nothing else. Every registration, refresh, approval,
kill-switch change, removal and call is audited with who, what, outcome and a **digest** of the
arguments, never the arguments or the result (tests assert both are absent). The audit store's interface
has no update or delete. Entries are tenant-scoped. Calls are rate limited per user, and a disabled
server answers nothing (the kill switch).

### 8. The agent gets MCP tools from the gateway, per request

The agent asks the gateway which tools this user may call, on each request, and wraps them as tools. The
gateway's risk class carries over, so an MCP `write` tool pauses for the owner's approval exactly like a
built-in one, and the tool is looked up again at approval, so one that was withdrawn does not run. A
built-in tool cannot be replaced by a name clash. If the gateway is down the agent keeps its built-in
tools and the run continues.

## Proof

Unit tests run against a real MCP server over HTTP (JSON and event-stream replies, pagination, timeouts,
oversized and malformed responses); end-to-end tests run the gateway, a real CRM that verifies the bearer
token it receives, and the agent together. Breaking each safeguard on purpose (role check, changed-tool
check, re-verification, argument validation, result screening, the reviewed-hash check, the pin
comparison, description screening, private-address checks for literals and for resolved names, the
response cap, audit tenant scoping) fails the tests written for it.

## Consequences

- The registry and the **audit log are in memory**: they are lost on restart, which is not acceptable for
  an audit log. Production needs Cosmos DB (partitioned by tenant) with immutable storage for the log.
- Only the **Streamable HTTP** transport and the tools feature are supported: no stdio servers, no
  resources, prompts or sampling, no OAuth discovery for servers. Each operation opens its own session
  (three round trips), which keeps the gateway stateless but is slower than a held connection.
- The rate limit is **per process**; several replicas need a shared counter.
- The hash covers what a server _says_ about a tool. It cannot detect a tool that starts behaving
  differently, so approval still rests on trusting the server's owner. An admin who approves a hostile
  but well-disguised tool defeats the screen.
- Schema validation uses the schema the server published, including any `pattern` in it, which a
  malicious schema could make expensive; approval is the control.
- When an `obo` server is registered or refreshed, the tool list is read with the **admin's** identity,
  which may differ from what a user would get.
- The agent tells the model only the category of a gateway refusal ("not available", "under review", "bad
  arguments"), not the schema issues.
- Everything was exercised with test doubles for the model and a scripted MCP server. Real third-party
  servers, which are often sloppier than a test double, are untested.
