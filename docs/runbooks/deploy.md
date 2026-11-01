# Deploy the platform to a new environment

> **Not yet rehearsed on a real cluster.** The steps follow from the Terraform, the chart and their
> tests, but nothing here has been run against Azure. Treat the first run as the rehearsal, in a
> throw-away environment, and correct this page with what you find.

## 1. Infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example staging.tfvars      # set subscription, environment, admin group
cp backend.hcl.example backend.hcl              # point at the state storage account
terraform init -backend-config=backend.hcl
terraform plan -var-file=staging.tfvars -out plan.out
terraform apply plan.out
```

The state storage account is created once, by hand, outside this configuration (blob versioning on,
no public access). Read `terraform output` for everything the next steps need.

## 2. Secrets (once per environment)

Terraform does not write secrets, so none end up in its state. The identity doing this needs the Key
Vault Secrets Officer role on the vault (the `key_vault_secrets_officers` variable grants it).

```bash
KV=$(terraform output -raw key_vault_name)
# Azure OpenAI keys: one per account
az keyvault secret set --vault-name "$KV" --name aoai-primary-key \
  --value "$(az cognitiveservices account keys list -g <rg> -n <primary account> --query key1 -o tsv)"
az keyvault secret set --vault-name "$KV" --name aoai-secondary-key \
  --value "$(az cognitiveservices account keys list -g <rg-secondary> -n <secondary account> --query key1 -o tsv)"
# A random salt for the tenant pseudonym on spend metrics
az keyvault secret set --vault-name "$KV" --name telemetry-pseudonym-salt --value "$(openssl rand -hex 32)"
# The Entra client secrets of the four services that sign in (created in Entra, never pasted in chat or a ticket)
for s in assistant agents mcp-gateway ingestion; do
  az keyvault secret set --vault-name "$KV" --name "$s-client-secret" --value "<value from Entra>"
done
```

## 3. Cluster prerequisites

The chart assumes an ingress controller (`ingress-nginx`), cert-manager, the Prometheus Operator
(`monitoring` namespace), the Key Vault CSI driver (enabled by Terraform) and, for canary releases,
Argo Rollouts. Turn off what is not installed: `rollouts.enabled`, `monitoring.*.enabled`, `ingress.enabled`.

## 4. Images

CI builds one image per service. Push them to the registry from `terraform output acr_login_server` under
one tag (a version or a commit), and use that tag below. There is no `latest`: the chart refuses to render
without a tag.

## 5. Install

```bash
az aks get-credentials -g "$(terraform output -raw resource_group)" -n "$(terraform output -raw aks_name)"
kubectl create namespace genai
helm upgrade --install genai deploy/helm/genai-platform -n genai -f my-values.yaml \
  --set image.tag=<tag> --set image.registry=<acr login server>
```

`my-values.yaml` holds the environment's issuer, keys URL, token endpoint, vault name, tenant,
`serviceIdentities` (from `terraform output service_identity_client_ids`) and the Entra `clientId` of each
signing-in service. `helm template` with those values must succeed before anything is applied.

## 6. Verify

1. `kubectl -n genai get pods`: every pod ready; a pod that restarts at once usually lacks a secret or
   a value the service insists on (it refuses to start rather than guess).
2. Ask a question through the assistant's ingress host with a real token; the response has `x-trace-id`.
3. In Prometheus, `slo:sli_error:ratio_rate5m` has a series per SLO (after a few minutes of traffic), and
   the targets page shows seven healthy `genai` targets. If it shows none, check the ServiceMonitor's
   `honorLabels` and the release label your Prometheus selects on.
4. No alert named `*TelemetryMissing` is firing.
