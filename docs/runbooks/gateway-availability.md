# Model gateway availability

**Alerts:** `GatewayAvailability{Fast,Slow,Steady,Drip}Burn`. **SLO:** 99.5% of model calls that were
admitted get an answer, from the primary deployment or its fallback.

Calls refused by a limit (rate, token quota, daily budget) are `rejected`, not errors, and do not
count against this SLO: a limit doing its job is not a fault. They are on the dashboard under "Model
calls by deployment and outcome".

## First five minutes

1. Dashboard, "Model calls by deployment and outcome": is `error` rising for one deployment or all?
2. If one: the fallback should be covering. Check `fallback_served`. If it is not, the router has
   no healthy deployment left.
3. If all: the problem is upstream (the provider, a region, our credentials) or ours (egress,
   network). Open a failing trace; the gateway's request span has `error.type` set.

## Actions

- A provider outage: nothing to do but wait and keep the fallback healthy. Tell users.
- Expired or rotated credentials: fix the secret; do not paste keys in a chat or ticket.
- A deployment returning 429s: check the tenant's token usage (`GET /v1/usage`) and the provider's
  quota; raise it or lower `AZURE_OPENAI_DEPLOYMENTS` weights.
