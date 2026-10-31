# ADR 0005: Queue-driven, idempotent ingestion

- Status: Accepted
- Date: 2026-10-31

## Context

Documents must be turned into searchable chunks before the assistant can use them. Processing is
slow (parsing, chunking, later embedding and indexing), depends on external services that fail, and
arrives in bursts (a customer uploads a thousand files). Some documents are simply unprocessable.

## Decisions

### 1. Asynchronous, queue-driven instead of synchronous

`POST /v1/documents` validates, records a job, enqueues it and returns `202 Accepted` with a job id.
A worker processes it in the background; clients poll the job.

| Concern       | Synchronous request                  | Queue + worker                             |
| ------------- | ------------------------------------ | ------------------------------------------ |
| Latency       | Caller waits for the whole pipeline  | Immediate response                         |
| Bursts        | Overload the API itself              | Absorbed by the queue, drained at our pace |
| Failures      | Caller must retry by hand            | Automatic retries with backoff             |
| Scaling       | Scales web tier and workers together | Add workers independently                  |
| Bad documents | Fail the request                     | Parked in a dead-letter queue              |

The cost is eventual consistency: a document is not searchable the instant the upload returns.

### 2. Peek-lock queue contract (Service Bus semantics)

The `MessageQueue` port copies Azure Service Bus: `receive` locks a message for a visibility
timeout; `complete` removes it; `abandon` redelivers after a delay; an expired lock (crashed worker)
redelivers automatically; lock tokens reject a stale worker; after `maxDeliveries` the message goes
to the dead-letter queue, enforced by the queue itself so a crash-looping worker cannot retry
forever. The in-memory adapter keeps the service runnable and testable with no cloud account.

### 3. Idempotency at two levels

Queues deliver **at least once**, so the same job can arrive twice. The pipeline must therefore be
safe to repeat:

1. **Content hash check:** if the indexed document already has this hash, skip everything.
2. **Replace as a unit with deterministic ids:** chunks are keyed `documentId:index` and the
   document is replaced atomically, so a retry after a partial failure or an edited re-upload leaves
   no duplicate chunks and no stale chunks from an older, longer version.

_Alternative:_ exactly-once delivery. Not available in practice; idempotent consumers are simpler
and more robust.

### 4. Permanent vs transient failures

An unsupported or empty document will fail the same way every time, so it is dead-lettered
immediately without wasting retries. Anything else is treated as transient and retried with
exponential backoff and full jitter, then dead-lettered with the last error once retries are
exhausted. Operators can list dead letters per tenant and requeue after fixing the cause.

### 5. Chunking strategy chosen per file type

One strategy does not fit all content:

- **Markdown:** split along headings, never across sections; record the heading path as metadata
  (shown as context in answers); keep fenced code whole.
- **Prose:** paragraph and sentence packing with word-boundary overlap, so a sentence straddling a
  boundary is retrievable from either side.
- **CSV:** whole rows grouped together with the header repeated in every chunk, because a bare row
  of values is meaningless without its column names.

## Consequences

- Uploads are fast and resilient; failures are visible and recoverable.
- Documents are limited to 200 KB inline (Service Bus messages max out at 256 KB). Larger files
  require uploading to blob storage and passing a reference, which is future work.
- PDF and Office formats are not supported yet; they need a text-extraction stage in front of the
  chunkers. They currently dead-letter with a clear reason.
- State (queue, index, jobs) is in memory, so it is lost on restart. Production uses Service Bus,
  Azure AI Search and Cosmos DB behind the same ports.
- Embeddings are added when the retrieval service is built (Step 5).
