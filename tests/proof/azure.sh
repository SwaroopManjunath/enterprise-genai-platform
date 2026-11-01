#!/usr/bin/env bash
# The proof run against a real Azure OpenAI deployment: evaluation, cache benchmark and load test.
# Read docs/proof/README.md first. Nothing here prints or stores the key.
#
#   read -rs AZURE_OPENAI_API_KEY; export AZURE_OPENAI_API_KEY
#   export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com AZURE_OPENAI_DEPLOYMENT=<name>
#   export MODEL_INPUT_USD_PER_MTOK=<price> MODEL_OUTPUT_USD_PER_MTOK=<price>
#   tests/proof/azure.sh
#
# Settings: RUNS (evaluation runs per case, default 3), RATES (load rates in requests per second,
# default "1 2 3": keep them under what the deployment's tokens-per-minute quota allows), DURATION.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
for v in AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT AZURE_OPENAI_DEPLOYMENT; do
  [ -n "${!v:-}" ] || { echo "set $v first (see the header of this script)"; exit 2; }
done
export MODEL=azure
RUNS=${RUNS:-3}
RATES=${RATES:-1 2 3}
export DURATION=${DURATION:-45s}
PROOF="$ROOT/docs/proof"
mkdir -p "$PROOF"

step() { printf '\n== %s\n' "$*"; }
npm run build -w @genai/shared -w @genai/auth -w @genai/guardrails -w @genai/observability >/dev/null

step "1/5 can the platform use this deployment?"
npm run -s azure:check -w @genai/e2e || exit 1

step "2/5 evaluation: $RUNS runs of every case (the gate may fail: that is a result, not an error)"
npm run -s eval -w @genai/evals -- --model azure --runs "$RUNS" | tee "$PROOF/eval-azure.txt"
cp "$ROOT/tests/evals/results/good.azure.md" "$PROOF/eval-azure.md" 2>/dev/null || true
cp "$ROOT/tests/evals/results/good.azure.json" "$PROOF/eval-azure.json" 2>/dev/null || true

step "3/5 the cache, off against shadow against serving, on the real model"
npm run -s bench -w @genai/e2e -- --azure | tee "$PROOF/bench-azure.txt"

step "4/5 load, answer cache off (rates: $RATES)"
CACHE_MODE=off tests/load/run.sh azure-cache-off $RATES

step "5/5 load, answer cache serving"
CACHE_MODE=serve tests/load/run.sh azure-cache-serve $RATES

printf '\nDone. Results are in docs/proof/. Nothing has been committed.\n'
