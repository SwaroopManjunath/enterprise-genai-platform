# Terraform: the Azure infrastructure

What it creates, and why each choice, is in [ADR 0016](../../docs/adr/0016-delivery.md). In short: AKS
(Entra sign-in only, workload identity, network policy), a registry, a Key Vault under RBAC, one identity
per service, and two Azure OpenAI accounts in two regions.

> **Status.** `terraform fmt` and `terraform validate` pass in CI. It has not been planned or applied
> against a real subscription.

```bash
terraform init -backend-config=backend.hcl
terraform plan -var-file=staging.tfvars
```

Not created here, on purpose: Cosmos DB, AI Search and Service Bus (the platform's stores and queues are
still in-memory), Entra app registrations (the issuer, audiences and client ids are inputs), private
endpoints, and any secret value. See [the deploy runbook](../../docs/runbooks/deploy.md) for the steps
after `apply`.
