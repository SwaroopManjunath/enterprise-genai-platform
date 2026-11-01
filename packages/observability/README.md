# @genai/observability

Traces, metrics and logs for every service, and the service-level objectives, alerts and dashboard built
on them. One library, so the rules about what telemetry may say are kept in one place.
See [ADR 0015](../../docs/adr/0015-observability.md) for why it is built this way.

> **Honest limits.** Nothing here has run against a real collector, Prometheus or Grafana yet (Step 14
> deploys them). The alert rules are checked by our own tests, not by `promtool`, and the targets are
> reasoned rather than measured against real traffic.

## Use

In a service's `main.ts` (already done for all seven):

```ts
const telemetry = startTelemetry('assistant');
const app = await NestFactory.create(AppModule, { logger: telemetry.logger });
```

In its module: `imports: [TelemetryModule.forService('assistant')]`. Every request is then counted, timed
by route template, traced (continuing the caller's `traceparent`) and logged as one JSON line, and the
response carries `x-trace-id`. Calls through `HttpJsonClient` send the trace on to the next service.

Record what a service does against the catalog, never with free text:

```ts
const metrics = metricsFor('retrieval');
metrics.observe('retrievalResults', { mode: 'hybrid' }, hits.length);
annotate({ 'genai.results.count': hits.length }); // an attribute on the request's span
await withSpan(getTracer('retrieval'), 'retrieval.search', () => search(), {
  attributes: { 'genai.search.mode': 'hybrid' },
});
```

## Configuration

| Variable                      | Effect                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Send traces and metrics to a collector (`http://collector:4318`)       |
| `METRICS_PORT`                | Expose Prometheus metrics on this port instead                         |
| `OTEL_SDK_DISABLED=true`      | Record nothing, whatever else is set                                   |
| `OTEL_SERVICE_NAME`           | Override the service name                                              |
| `SERVICE_VERSION`             | Reported as the service version                                        |
| `DEPLOYMENT_ENVIRONMENT`      | Reported as the environment (`staging`, `production`)                  |
| `TELEMETRY_PSEUDONYM_SALT`    | Salt for the tenant pseudonym on spend metrics; set one per deployment |

With none of the first two set a service exports nothing, by design.

## What telemetry may carry

An allowlist, applied when attributes are set and again when spans are exported:

- **Span attribute keys**: a few known HTTP keys, or anything under `genai.`.
- **Values**: identifier-like strings (no spaces, at most 64 characters, not a JWT), numbers, booleans.
  A question, an answer or a token cannot pass.
- **Span events and status messages** are dropped. An error is recorded as its type only.
- **Metric labels**: 18 fixed names. Tenants appear only as a keyed hash.
- **Context**: `traceparent` only, no baggage.
- **Logs**: JSON, scrubbed of anything that looks like a credential, never a body or a query string.

An identifier-like value such as a tenant name would pass the value rule, so the code does not record them
and `tests/e2e` scans every span, metric point and log line for planted text (a question, a document, an
IBAN, a token, the tenant and the user) and fails if any is found.

## Metrics

Defined once in `src/metrics.ts` (`CATALOG`), used by the code, the alert rules and the dashboard.

| Metric (as Prometheus sees it)                    | Meaning                                                    |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `http_server_requests_total`                      | Requests by service, route template, method, status class  |
| `http_server_duration`                            | Request time histogram                                     |
| `genai_assistant_answers_total`                   | Answers by outcome (grounded, blocked, cache_hit, error..) |
| `genai_assistant_first_token`                     | Time to the first streamed words                           |
| `genai_guardrails_events_total`                   | Guardrail decisions by kind and action                     |
| `genai_llm_calls_total` / `genai_llm_duration`    | Model calls by deployment and outcome; their duration      |
| `genai_llm_tokens_total` / `genai_llm_cost_total` | Tokens by direction; spend in micro-dollars by pseudonym   |
| `genai_retrieval_results`                         | Results returned per search                                |
| `genai_ingestion_jobs_total` / `_duration`        | Ingestion results and processing time                      |
| `genai_agent_runs_total` / `_tool_calls_total`    | Agent runs by status; tool calls by tool and outcome       |
| `genai_mcp_calls_total`                           | Everything the MCP gateway audited, by action and outcome  |

## SLOs, alerts and the dashboard

`src/slo/slos.ts` defines six objectives and four burn-rate tiers. `npm run ops:generate` writes
`ops/prometheus/rules.yaml` (recording rules and alerts) and `ops/grafana/genai-platform.json`;
`npm run ops:check` fails if the committed files differ from what the code produces, and CI runs it.
Each alert links to a runbook in [`docs/runbooks`](../../docs/runbooks).

| SLO                        | Objective                          | Alerts         |
| -------------------------- | ---------------------------------- | -------------- |
| Assistant availability     | 99.5% of asks without a 5xx        | pages, tickets |
| Assistant latency          | 95% of answers within 5 s          | pages, tickets |
| Assistant first token      | 95% of streams start within 1.5 s  | pages, tickets |
| Model gateway availability | 99.5% of admitted calls answered   | pages, tickets |
| Ingestion success          | 99% of documents become searchable | tickets        |
| Answer grounding           | 90% of answers cite their sources  | tickets        |

Tiers: 14.4x over 1h and 5m, 6x over 6h and 30m (pages); 3x over 1d and 2h, 1x over 3d and 6h (tickets).

## Tests

```bash
npm test -w @genai/observability   # allowlist, spans, metrics, logs, request middleware, SLO maths and simulations
npm run ops:check                  # committed rules and dashboard match their definitions
```
