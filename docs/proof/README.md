# Proof

Measured results, and how to reproduce them. Everything here was produced by running the code in this
repository; a result file says what it measured and on what.

| File                                                   | What it is                                                                   | Needs        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------ |
| `load-capacity-mock.md`                                | How much traffic the platform itself carries, with an instant stand-in model | Docker       |
| `eval-azure.md`                                        | The evaluation, run three times per case on a real model, judged by a model  | Azure OpenAI |
| `bench-azure.txt`                                      | The answer cache off, in shadow mode and serving, on a real model            | Azure OpenAI |
| `load-azure-cache-off.md`, `load-azure-cache-serve.md` | Sustained load on a real model, without and with the cache                   | Azure OpenAI |

## Reproduce the platform's capacity (no model, no key)

```bash
tests/load/run.sh capacity-mock 10 50 100 200 400 600 800 1000
```

Starts the compose stack, steps through arrival rates for 30 seconds each, and writes the report. The
load generator, the monitoring stack and the services share one Docker Desktop VM, so the numbers are what
this machine did, not a production sizing.

## Run it on a real Azure OpenAI deployment

You need an Azure OpenAI resource with one chat deployment (its name, not the model's). The run uses
roughly 450,000 tokens in total (about a dollar at GPT-4o-class prices) and takes 30 to 40 minutes.
**Keep the load rates under the deployment's tokens-per-minute quota**: each request is about 300
tokens, so 3 requests a second is about 54,000 tokens a minute.

In your own terminal (so the key never appears on a screen, in a file or in a chat):

```bash
read -rs AZURE_OPENAI_API_KEY; export AZURE_OPENAI_API_KEY      # type or paste the key, then Enter
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
export AZURE_OPENAI_DEPLOYMENT=<deployment name>
export MODEL_INPUT_USD_PER_MTOK=<dollars per million input tokens>     # your contract's prices
export MODEL_OUTPUT_USD_PER_MTOK=<dollars per million output tokens>

npm run -s azure:check -w @genai/e2e     # one cheap round trip: does the platform work with this deployment?
tests/proof/azure.sh                     # the whole run
```

`azure:check` names the usual cause when something is wrong (a wrong deployment name, a model that
rejects a temperature setting, no quota). `AZURE_JUDGE_DEPLOYMENT` names a second deployment to grade
answers, which is better than the model grading itself. Settings for the run: `RUNS` (default 3),
`RATES` (default `1 2 3`), `DURATION` (default `45s`).

Nothing is committed by the scripts. The key is read from the environment by the process that needs it,
passed to the gateway container as an environment variable, and printed nowhere.
