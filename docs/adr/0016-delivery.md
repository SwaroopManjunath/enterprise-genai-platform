# ADR 0016: Delivery

- Status: Accepted
- Date: 2026-11-01

## Context

Thirteen steps produced seven services that pass their tests in one process. None of that says they can
be built into images, run apart from each other, found and watched by a real Prometheus, deployed with
a policy that is safe by default, or rolled out without a person watching a graph. It also left a debt:
Step 13's alert rules had been checked only by our own tests, never loaded into a Prometheus.

Delivery is where "works on my machine" gets tested, so the aim is to run as much as possible for real
here (images, compose, Helm rendering against Kubernetes and CRD schemas) and to say plainly what could
not be (a cluster, Azure).

## Decisions

### 1. One Dockerfile for all seven services, small in attack surface

Three stages: build everything with the dev dependencies, install the production dependencies of one
service (`npm ci --omit=dev --workspace`), and copy just that into a runtime image. The image runs as
uid 1000 with no write access to what it runs, has a health check that needs only Node, and has npm,
npx, corepack and yarn removed: the service never runs them, they bundle the modules scanners flag
most, and removing them also removes a way to install more. A service started without its
configuration refuses to run (the image does not start with defaults).

Every image is scanned for high and critical vulnerabilities that have a fix. The first scan found
eleven: ten were npm's own bundled modules (fixed by removing npm) and one was `multer`, which
`@nestjs/platform-express` 11.x pins to 2.4.0 (fixed in 2.5.0, shipped with platform-express 12). An npm
`overrides` entry would not take effect against that exact pin, and no service uses file uploads, so
it is a recorded exception in `.trivyignore.yaml` with a reason and an expiry (2026-12-15), after which
the scan fails again until Nest is upgraded.

### 2. A compose stack with real monitoring, because it finds what unit tests cannot

`deploy/compose` runs the seven services from the images, a local identity provider (the dev token
endpoint, now serving several clients), Prometheus loading `ops/prometheus/rules.yaml`, Grafana with the
generated dashboard and Jaeger. A smoke test drives the real API and checks the scrape, the trace and
the rules; CI runs it. Running it found a real bug in Step 13: the Prometheus endpoint listened on the
IPv6 loopback only, so nothing outside the process could scrape it (now `0.0.0.0`, with a test that
fetches it over IPv4 and fails on the old behaviour). It also gave the generated rules their first real
test: 78 rules load with no errors and produce values from real traffic.

`deploy/compose/prove-alerts.sh` rehearses an outage: it stops the retrieval service, keeps asking
questions, and follows `AssistantAvailabilityFastBurn` from inactive to pending (45 seconds, 5-minute
error ratio 0.71) to firing (166 seconds, 0.90). That is the alert the SLO code defines, firing against
a real failure, with real metrics.

### 3. One Helm chart, safe by default

All seven services come from one chart so their policies cannot drift apart. Each pod runs as non-root
with a read-only filesystem, no capabilities, the runtime-default seccomp profile, no Kubernetes API token,
memory limits without a CPU limit (throttling shows up as latency), and startup, readiness and liveness
probes. Replicas belong to the HorizontalPodAutoscaler, and a PodDisruptionBudget keeps a node upgrade
from taking the last pod. There is no default image tag and no `latest`: the chart refuses to render
without one, and without the issuer, keys, vault, identities and client ids it cannot guess.

The network is closed by default. Each service's NetworkPolicy is derived from one declaration, `calls`:
it may reach exactly those services and be reached by exactly the services that call it. Only four
services (assistant, agents, ingestion, MCP gateway) are reachable from the ingress controller, and egress
to the internet (the identity provider's keys and tokens, the model, the MCP tool servers) excludes every
private range.

Secrets reach pods through the Key Vault CSI driver with the pod's own workload identity, synced to a
Kubernetes secret and read as environment variables, which the existing `EnvSecretProvider` already
does, so no application code changed. A service mounts only the secrets it reads; retrieval and the
prompt registry mount none. Wiring `KeyVaultSecretProvider` directly remains the alternative once there is
reason to avoid environment variables.

One trap is worth recording because it is silent: the platform's metrics carry their own `service`
label, and Prometheus renames a scraped label that collides with the target's own. The ServiceMonitor
sets `honorLabels: true`; without it every SLO rule would read nothing and never alert.

### 4. Canary releases that judge the canary, not the fleet

The assistant and the gateway are Argo Rollouts. A new version takes 25% and then 50% of the pods, and
while it does, three analyses read the metrics of the canary's own pods only: it must have had traffic
(a canary that received nothing has proved nothing), its 5xx ratio must stay at or below 3% (6 times the
0.5% budget of the availability objective, the "slow burn" page threshold), and no more than 15% of its
requests may take over 5 seconds (3 times the latency budget). A breach rolls back without a person.
A test derives those numbers from the SLO definitions, so loosening one without the other fails the
build. Rollouts are off by default, because they need Argo Rollouts installed; everything is a plain
Deployment until it is switched on.

### 5. Terraform, scoped to what the system uses

Terraform rather than Bicep, because it is what is installed and so what could be validated here.
It creates AKS (Entra ID sign-in only, no local accounts, Azure RBAC, workload identity, Cilium network
policy, zones), a registry with no admin user, a Key Vault under RBAC with purge protection and audit
logs, one identity per service with a federated credential bound to that service's service account, a
vault role only for the five services that read secrets, and two Azure OpenAI accounts in two regions.

It deliberately does not create Cosmos DB, AI Search or Service Bus: every store and queue in the
platform is still an in-memory stand-in, so provisioning them now would be infrastructure nothing uses.
It does not write secrets (Azure OpenAI keys, Entra client secrets) either: that would put them in the
state file, so an operator stores them once and the chart mounts them by name.

### 6. The chart, the Terraform and the SLOs are checked against each other

A test suite renders the chart and asserts, among other things, that the services it runs and the ones
that get a vault secret are exactly those the Terraform creates identities and vault access for, that
service account names match the federated credential subjects, that the alert rules it ships equal the
generated ones (the generator now writes the chart's copy too), and that the canary thresholds follow the
SLO budgets. A change on one side that is not made on the other fails a test.

## Consequences

- **Nothing here has run on Azure or AKS.** There is no cluster. The chart is verified by `helm lint`,
  rendering, validation of all 58 rendered resources against the Kubernetes and CRD schemas, and the policy
  tests; Argo Rollouts' behaviour, the CSI driver and workload identity are therefore unverified, and
  `terraform validate` proves the configuration is well-formed, not that `plan` or `apply` succeeds.
- Images are pinned by tag (`node:22-bookworm-slim`), not by digest, so a rebuild can pick up a new base.
  Pinning by digest and updating it automatically is the next step.
- Canary weighting is by replica count (granular with two or three pods); traffic splitting at the
  ingress needs a traffic router configured.
- The compose stack uses the mock model and local keys: it proves the wiring, not the quality of answers.
- Secrets must be created by hand once per environment, and the identity that does so needs the Key Vault
  Secrets Officer role; the runbook says how.
- The `multer` exception expires on 2026-12-15 and needs a Nest 12 upgrade to close.
- The registry, vault and OpenAI accounts are reachable on public endpoints (with authentication).
  Private endpoints and a private cluster are the hardening to do before real data arrives.
