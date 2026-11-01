# deploy

| Path                   | What it is                                                                  |
| ---------------------- | --------------------------------------------------------------------------- |
| `compose/`             | The whole platform on one machine, with Prometheus, Grafana and Jaeger      |
| `helm/genai-platform/` | The chart for Kubernetes: seven services, policies, alerts, canary rollouts |

## Run it locally

```bash
docker compose -f deploy/compose/docker-compose.yml up --build -d
docker compose -f deploy/compose/docker-compose.yml run --rm smoke     # drives the real API, checks metrics, trace, rules
deploy/compose/prove-alerts.sh                                         # stops retrieval and watches the alert fire
docker compose -f deploy/compose/docker-compose.yml down -v
```

Grafana is on http://127.0.0.1:3100, Prometheus on :9090, Jaeger on :16686 and the services on 3000-3006,
all bound to loopback. Development only: the identity provider is a stand-in with throw-away keys, the model is
the deterministic mock, and every secret in the compose file is a placeholder.

## The chart

```bash
helm lint deploy/helm/genai-platform -f deploy/helm/genai-platform/ci/full.yaml
helm template genai deploy/helm/genai-platform -f deploy/helm/genai-platform/ci/full.yaml --namespace genai
npm test -w @genai/delivery      # policy tests: hardening, network, secrets, canary, agreement with Terraform and the SLOs
```

`files/rules.yaml` is generated (`npm run ops:generate`); do not edit it. To install into a cluster see
[the deploy runbook](../docs/runbooks/deploy.md).
