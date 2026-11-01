# Model fallback serving

**Alert:** `ModelFallbackServing` (ticket): more than 20% of model calls were answered by the fallback
deployment for 10 minutes. Users are still served; the cover is thinner and the fallback may answer
a little differently.

## Check

1. Dashboard, "Model calls by deployment and outcome": which deployment is failing, and how (an `error`
   outcome with a rising count, or 429s)?
2. The gateway retries with backoff before it falls back, so a fallback share also shows as extra
   latency: check [assistant latency](assistant-latency.md).
3. Check the provider's status and your quota for the primary deployment.

## Act

- Provider incident: wait; make sure the fallback has capacity for all traffic.
- Quota: request more, or move some tenants off.
- Cost: the fallback usually has a different price. "Spend per hour" shows whether this is costing more.
