# ADR 0015: Observability

- Status: Accepted
- Date: 2026-11-01

## Context

Seven services now answer questions, call models, run agents and move documents. When one of them
is slow or wrong, the people on call need to see which request went where and how long each hop took,
and need to be told before users complain. Two things make this harder than adding a tracing library.

First, telemetry is a side door. The whole platform is built so that nobody sees what their role does
not allow, and telemetry is read by operators, kept for weeks and often sent to a third party. A trace
that carries a question, an answer, a document or a token undoes that work, and it does so quietly.

Second, an alert that has never been seen to fire may not work, and one that fires on every blip is
switched off. Both fail without anyone noticing until the incident they were meant for.

## Decisions

### 1. One small library, OpenTelemetry underneath, nothing exported by default

`@genai/observability` wraps the OpenTelemetry API and SDK: spans, a metric catalog, a JSON logger
and a Nest module. Services call it, not the SDK, so the rules below live in one place. Exports are
standard (OTLP, or a Prometheus scrape port) and switched on by configuration: with neither
`OTEL_EXPORTER_OTLP_ENDPOINT` nor `METRICS_PORT` set, a service records nothing anywhere, and the
instrumentation is a no-op. Tests read the same data from memory.

### 2. What telemetry may carry is an allowlist, enforced twice and then scanned

- A span attribute is kept only if its key is one of a few known HTTP keys or under `genai.`, and its
  value looks like an identifier or a number: no spaces, at most 64 characters, not a JWT. A question
  or an answer has spaces; a token is long and opaque; neither passes.
- The same rule runs again in the exporter, so a developer who calls the SDK directly and skips the
  helpers is still stopped. The exporter also drops span events (exceptions carry messages) and the
  status message, and keeps only an error's type.
- Metric labels are a fixed list of eighteen names, applied by the metrics pipeline itself, because
  every label multiplies what a metrics store holds. Route labels are templates (`/v1/runs/:id`), and
  a path nothing matched is `unmatched`, so a scanner cannot create a series per URL.
- A tenant is never a label; a keyed hash of it is (`genai.llm.cost` by tenant, for spend), different
  per deployment, so spend can be followed without the label being the tenant.
- Trace context travels in `traceparent` only. Baggage can carry arbitrary data, so it is not propagated.
- Log lines are JSON with the trace and span ids, and anything that looks like a credential is
  scrubbed. The access log holds method, route template, status, duration and a request id, never a
  body, a query string or a header.

This is defence in depth, not data-loss prevention. An identifier-like value (a tenant name, a user id)
passes the value rule, so the first defence is that the code never records them, and the last is a test:
a canary scan puts distinctive text in a question, a document and an IBAN, runs them through the real
services, and searches every span, metric point and log line for the question, the answer, the document,
the token (and its parts), the tenant and the user. It finds none, and it fails when a user id is
recorded as an identifier-like attribute or the real tenant id replaces its pseudonym.

### 3. Every request is observed, including the ones that never reach a controller

Request telemetry is Nest middleware, not an interceptor: a request without a token is a 401 produced
before any controller runs, and an interceptor would never see it. Each request continues the caller's
trace or starts one, is counted and timed by route template and status class, and the response carries
`x-trace-id`, so a user can quote it and an operator can open the whole story. The shared HTTP client
adds a client span and the header on every call, recording the downstream's name, the method and the
outcome, and never the path (it can hold an id), the body or the token.

### 4. The metric catalog is the single source for code, alerts and dashboards

Every metric is defined once, with its name, labels and buckets. Instrumentation records against the
catalog; the alert rules and the dashboard are generated from it. A test scrapes a real Prometheus
exporter and checks that each name the rules use is one it exposes. That test earned its keep: the
exporter in use does not append the unit to a name (`http_server_duration_bucket`, not
`..._milliseconds_bucket`), which the rules would otherwise have got wrong and nobody would have seen,
because a rule over a missing series is silent. Another test checks every selector in every rule uses
only labels its metric has. A metric nothing records (a "trimmed results" counter I had planned, whose
number the index does not expose) was removed rather than shipped as a flat line.

### 5. SLOs with burn-rate alerts, not thresholds on a graph

Six objectives, each with a plain-language meaning: assistant availability (99.5%), latency (95% of
answers within 5 seconds), first token (95% within 1.5 seconds), model gateway availability (99.5%),
ingestion success (99%) and answer grounding (90%). An alert says the error budget is being used too
fast, over two windows at once: 14.4x over 1 hour and 5 minutes, 6x over 6 hours and 30 minutes (both
page), 3x over a day and 2 hours, 1x over 3 days and 6 hours (both tickets). They spend 2%, 5%, 10% and
10% of a 30-day budget before firing. The long window says the problem is real, the short one that it
is still happening, so a blip does not page and a fixed problem stops paging within minutes.

Choices worth recording:

- Quality signals (grounding, ingestion) open tickets and never page: they are worth knowing and not
  worth waking someone.
- A call refused by a limit is `rejected`, not an error: a limit doing its job must not spend the
  availability budget.
- "No bad events yet" is zero, not missing data (`or vector(0)`): without it a service that has never
  failed has an empty error ratio, and an empty ratio never alerts.
- Silence is an alert. A service with no request counts for 15 minutes pages, because a blind SLO looks
  exactly like a healthy one.
- Four more alerts are not about a budget because they should never happen quietly: the fallback model
  serving a fifth of calls, a dead-lettered ingestion job, an MCP tool changed after review (a possible
  attack), and the silence above.
- Every alert links to a runbook in this repository, and a test fails if one is missing.

### 6. Rules and dashboards are generated, and drift fails the build

The SLO definitions are code; `npm run ops:generate` writes `ops/prometheus/rules.yaml` and
`ops/grafana/genai-platform.json`, and `npm run ops:check` (in CI) fails if what is committed differs
from what the code produces. Targets, the privacy allowlist and the generated files are under
CODEOWNERS, as the evaluation thresholds are: what counts as healthy, and what telemetry may say, are
changed by review.

### 7. Prove the alerts by playing traffic against them

The alert tiers are evaluated against simulated minute-by-minute error ratios. A total outage pages
within ten minutes. A two-minute blip pages no one. A steady 4% error rate (8x) pages on the slow tier
and never the fast one. A 1% leak (2x) never pages and raises only the slowest ticket, after about a day
and a half. Errors inside the budget are silent. A test also checks every tier can fire at all: for a
90% objective a 14.4x tier would need an error ratio above 1, which can never happen, and the SLO that
would have had one has no such tier.

### 8. The instrumentation is proven by breaking it

Twenty-two deliberate breakages were each caught by a test written for them: the allowlist accepting any
value or a JWT; the exporter keeping span events or the status message; the metric label allowlist
removed; the route label being the raw path or the catch-all; the logger not scrubbing; the client not
sending `traceparent` (caught by the client's own test and, separately, end to end); the real tenant id
in the cost metric; a user id leaked as an attribute; a counter name losing `_total`; the fast tier
weakened to 1x; the "no bad events yet" guard gone; the two-window condition turned into either-window;
an SLO target edited without regenerating the files; and the assistant's error outcome, the gateway's
rejected and fallback outcomes, agent runs and ingestion results not being counted. Two of them (the assistant's error outcome and the gateway's rejected and fallback outcomes) had
no test at all until the sabotage plan exposed it, so they now have one.

## Consequences

- No collector, Prometheus or Grafana runs yet; Step 14 deploys them. The rules are checked as YAML and
  against the exporter's names and the metrics' labels by our own tests, but they have not been loaded
  into a real Prometheus (`promtool` is not part of the build), and the dashboard has not been opened in
  a real Grafana. The first deployment is where both are exercised.
- Thresholds, the 5-second and 1.5-second latency targets and the 20% fallback share are reasoned, not
  measured. They are calibrated to nothing real until there is real traffic (Step 15); expect to move them.
- An ingestion job runs after the upload request has ended, so its trace is separate from the upload's.
  Linking them means carrying the trace context in the queued job.
- The MCP gateway calls third-party servers without a `traceparent`, on purpose: we do not hand our
  trace ids to code we do not run. The trace ends at the gateway's boundary.
- Per-tenant spend is a pseudonym label, so it can be followed but not read; the usage API remains the
  place to ask what a named tenant spent. Cardinality grows with tenants and needs watching.
- Spans and logs use the same trace ids, but logs are written to standard output and nothing ships or
  retains them yet.
- The identifier rule cannot tell a tenant name from a harmless label. That is why the first defence is
  not recording them, and why the scan and the code owners exist.
