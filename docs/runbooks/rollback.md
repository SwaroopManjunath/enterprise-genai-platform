# A release is going wrong

## During a canary (assistant, gateway)

The analysis aborts a canary by itself when its own pods breach the thresholds (5xx above 3%, more than
15% of requests over 5 seconds, or no traffic at all). To stop one by hand:

```bash
kubectl argo rollouts abort assistant -n genai     # the stable version takes all traffic again
kubectl argo rollouts get rollout assistant -n genai
```

An aborted rollout stays on the stable version until you fix and push a new tag or run
`kubectl argo rollouts retry rollout assistant -n genai`.

## After a full rollout

```bash
helm history genai -n genai
helm rollback genai <revision> -n genai
```

Roll back first, then find the cause. If an SLO burn alert fired, note how much budget was spent
(the dashboard's "budget left") in the write-up.

## Do not

- Edit a Deployment or Rollout by hand to change an image: the next `helm upgrade` undoes it silently.
- Turn guardrails to `monitor` to get traffic through. That removes protection and hides the real fault.
