#!/usr/bin/env bash
# Load-tests the running platform with k6, one arrival rate at a time, and writes a report.
#
#   tests/load/run.sh <name> <rate> [<rate>...]
#
# Settings (environment):
#   MODEL=mock|azure   the stand-in model (default) or a real deployment (see deploy/compose/azure.override.yml)
#   CACHE_MODE=off|shadow|serve   the assistant's answer cache (default off)
#   DURATION=30s       how long each rate is held
#   STREAM=1           ask for streamed answers
#   NO_CACHE=1         ask for a fresh answer every time
#
# Examples:
#   tests/load/run.sh capacity-mock 10 25 50 100 200 400
#   MODEL=azure CACHE_MODE=serve tests/load/run.sh azure-cache-serve 2 4
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME=${1:?usage: run.sh <name> <rate>...}
shift
RATES=("$@")
[ ${#RATES[@]} -gt 0 ] || { echo "give at least one rate"; exit 2; }

FILES=(-f "$ROOT/deploy/compose/docker-compose.yml" -f "$ROOT/deploy/compose/load.override.yml")
[ "${MODEL:-mock}" = azure ] && FILES+=(-f "$ROOT/deploy/compose/azure.override.yml")
C="docker compose ${FILES[*]}"
OUT="$ROOT/tests/load/results/$NAME"
DURATION=${DURATION:-30s}
mkdir -p "$OUT"
rm -f "$OUT"/*.json "$OUT"/*.csv

echo "starting the platform (model: ${MODEL:-mock}, cache: ${CACHE_MODE:-off})"
$C down -v >/dev/null 2>&1 || true
CACHE_MODE=${CACHE_MODE:-off} $C up -d --build --wait >/dev/null 2>&1
$C run --rm -T -v "$ROOT/tests/evals/datasets:/datasets:ro" smoke seed 2>/dev/null | tail -1
TOKEN=$($C run --rm -T smoke token 14400 2>/dev/null | tail -1)
[ -n "$TOKEN" ] || { echo "could not mint a token"; exit 1; }

k6() { # k6 <rate> <duration> <summary file or empty>
  local summary=()
  [ -n "${3:-}" ] && summary=(--summary-export "/out/$3")
  docker run --rm --network genai_default \
    -v "$ROOT/tests/load:/load:ro" -v "$ROOT/tests/evals/datasets:/datasets:ro" -v "$OUT:/out" \
    -e RATE="$1" -e DURATION="$2" -e TOKEN="$TOKEN" -e NO_CACHE="${NO_CACHE:-}" -e STREAM="${STREAM:-}" \
    grafana/k6:1.0.0 run --quiet ${summary[@]+"${summary[@]}"} /load/ask.js >/dev/null 2>&1 || true
}

echo "warming up"
k6 3 10s ""

for RATE in "${RATES[@]}"; do
  echo "offering $RATE requests per second for $DURATION"
  (while :; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' | sed "s/^/$RATE,/" >>"$OUT/stats.csv"
    sleep 2
  done) &
  SAMPLER=$!
  k6 "$RATE" "$DURATION" "rate-$RATE.json"
  kill "$SAMPLER" 2>/dev/null || true
  wait "$SAMPLER" 2>/dev/null || true
done

sleep 12   # one more scrape, so the last requests are in Prometheus
node "$ROOT/tests/load/report.mjs" "$NAME" "${RATES[@]}"
$C down -v >/dev/null 2>&1 || true
