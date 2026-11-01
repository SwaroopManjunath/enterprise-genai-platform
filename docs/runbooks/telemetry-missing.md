# Telemetry missing

**Alerts:** `<Service>TelemetryMissing`. No request counts have arrived for 15 minutes. Every SLO that
depends on the service is blind, and a blind SLO looks exactly like a healthy one.

## Check

1. Is the service up? `GET /health` on it. If not, this is an outage: use that service's runbook.
2. If it is up: is it exporting? Metrics are exposed on `METRICS_PORT` (Prometheus scrape) or pushed to
   `OTEL_EXPORTER_OTLP_ENDPOINT`. Neither set means nothing is exported, by design.
3. Is Prometheus scraping it? Check the target page. A changed port, a network policy or a renamed
   service all end here.
4. Is traffic actually zero? In a quiet environment (night, a staging cluster) this alert can be
   true and harmless. Send a request and watch the counter move.

Do not silence it for a service that has real traffic until its telemetry is back.
