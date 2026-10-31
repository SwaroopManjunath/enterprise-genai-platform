# ADR 0009: Connecting ingestion to search

- Status: Accepted
- Date: 2026-10-31

## Context

ADR 0008 ended with a gap: the assistant could answer from documents, but only because the test put
them into the search index directly. An uploaded file never became searchable. Closing that gap is
mostly a security problem, not a plumbing one: the ingestion pipeline runs in the background with no
user, yet what it writes decides what the assistant will quote as evidence and who is allowed to
read it.

## Decisions

### 1. The pipeline writes to search as itself, not as a user

Background work has no user token to exchange, so ingestion authenticates with its **own identity**
(OAuth client-credentials flow) and holds a single narrow app role, `indexer`. Its token is bound to
the retrieval API (audience), cached per API until shortly before expiry, and never reused anywhere
else. The client secret is read by name from the secret store.

_Alternatives:_ (a) store the uploader's token in the queue message and use it later. Rejected:
tokens expire in about an hour, queues retry for longer, and a stored credential is a theft target.
(b) let ingestion and retrieval share one database. Rejected: it removes the service boundary where
access control lives.

### 2. The service names the tenant; only the `indexer` role may

A service identity belongs to the platform, not to a customer, so its token cannot say which tenant a
document is for. Index writes therefore take the tenant in the path
(`/v1/tenants/:tenant/index/documents/:id`), honoured only for a caller with the `indexer` role. End
users, even managers, get 403 (tested).

The tenant itself is fixed at submit time from the uploader's **verified token**, then travels in the
job. The pipeline never trusts a tenant claimed by anything it merely read from the queue about the
user. The old tenant-less index routes were removed, not kept alongside.

**Blast radius, stated plainly:** a compromised ingestion service could write to any tenant's index.
Mitigations in place: the role grants write only (a test shows the service identity cannot read
customer documents), tokens are audience-bound, and writes replace whole documents. Not yet in place:
network isolation and per-tenant scoping of the service identity.

### 3. The access list travels with the upload, and uploading is privileged

An upload carries `allowedRoles` and `tags`, normalised, from the request through the queue to the
index, where retrieval trims by them. Uploading and viewing upload status need the `document-admin`
role: an uploaded document is later cited as evidence, so letting any tenant member upload would let
anyone plant content the assistant quotes. Dead-letter operations stay a separate `ingestion-admin`
role. An admin is trusted to choose an access list; there is no per-document ownership yet, so one
admin can overwrite another's document id.

### 4. The "unchanged" check covers the access list, not just the text

The pipeline skips a re-upload whose content hash matches what the index holds. The hash is computed
over the content **and** the access list. If it covered text only, re-uploading identical text with a
tighter list would be skipped as "unchanged" and the old, looser access would silently remain, which
is the dangerous direction. A test uploads the same text open, then restricted, and checks the job is
applied (not skipped) and the analyst loses access. Sabotaging the hash to ignore access fails
exactly that test.

### 5. Ingestion serves no content

Ingestion exposed `GET /v1/documents/:id/chunks` to any tenant member. With restricted documents
flowing through it, that would have been a way around retrieval's role trimming, so the endpoint and
the port's read-back were removed. Only retrieval returns content, after trimming by the caller's
tenant and roles. What remains in ingestion (job status, document hash and chunk count) needs
`document-admin` and never includes text.

### 6. Index failures feed the existing retry policy

An index rejection (400 or 413) means this document can never be indexed, so it is dead-lettered at
once. An index that is down, slow, throttled, or refusing our credentials may recover, so it is
retried with backoff and, after the delivery limit, parked in the dead-letter queue with the reason
instead of being lost. Both are tested end to end, including the search service being stopped
mid-upload.

### 7. The sink is explicit configuration

`INDEX_SINK=retrieval` writes to search; `memory` keeps chunks in-process for development and tests.
Choosing `retrieval` without its settings fails startup. The `memory` default logs, at startup, that
uploaded documents are not searchable, so a misconfigured deployment is loud rather than silently
useless.

## Consequences

- Upload to answer is now real and tested end to end across ingestion, retrieval and the assistant:
  an upload becomes answerable with a citation, a restricted upload stays restricted, an edit replaces
  the old text, and failures park in the dead-letter queue.
- Searchability is eventually consistent: there is a short delay between upload and answerability.
- There is no delete: removing a document from search is possible in retrieval but not yet exposed
  through ingestion.
- Content is trusted once a `document-admin` uploads it. Instructions hidden in a document's prose
  ("ignore the above") are not defended against yet; that is the guardrails step. There is no
  malware scanning, and PDF/Office files are still unsupported.
- This changes the retrieval index API (routes moved under `/v1/tenants/:tenant`), acceptable before
  any external client exists.
- Everything still runs on local stand-ins in one process; nothing has run against real Azure,
  Service Bus or Entra ID. The client-credentials flow is tested against a local token endpoint that
  follows the documented contract.
- This resolves the first consequence listed in ADR 0008 (ingestion not connected to retrieval).
