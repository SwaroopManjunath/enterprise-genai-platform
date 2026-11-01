# Ingestion success

**Alerts:** `IngestionSuccess{Steady,Drip}Burn` (tickets). **SLO:** 99% of documents sent in become
searchable instead of failing for good.

## Check

1. Dashboard, "Ingestion jobs by result". Rising `retried` with few `failed` is a struggling
   dependency (the embedder or retrieval's index). Rising `failed` or `dead_lettered` is bad input or a bug.
2. `GET /v1/dead-letters` lists what gave up and why. Read the reasons: a permanent error (an
   unsupported or empty document) is not worth retrying.
3. Fix the cause, then `POST /v1/dead-letters/{jobId}/requeue`. Requeueing is safe: the pipeline is
   idempotent, so a document that was half-processed is not duplicated.

See also [dead-lettered jobs](ingestion-dead-letter.md).
