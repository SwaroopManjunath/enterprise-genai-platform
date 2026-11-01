# Ingestion dead-lettered

**Alert:** `IngestionDeadLettered` (ticket): a document used all its attempts, or hit a permanent error,
and was set aside. It is not searchable and nothing retries it by itself.

## Do

1. `GET /v1/dead-letters` and read the `error` of each job. It never contains the document's content.
2. Decide: **permanent** (empty file, unsupported type, too large): tell whoever uploaded it; there is
   nothing to requeue. **Transient** (the retrieval index or embedder was down): once healthy,
   `POST /v1/dead-letters/{jobId}/requeue`.
3. Check the document appears: `GET /v1/documents/{documentId}` and ask a question only it can answer.

Several dead letters at once points to a dependency, not to the documents: look at "Ingestion jobs by
result" for a spike of `retried` first.
