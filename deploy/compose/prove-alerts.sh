#!/usr/bin/env bash
# Rehearses an outage against the running compose stack and watches the generated alert fire:
# stop the retrieval service, keep asking questions, and follow AssistantAvailabilityFastBurn from
# inactive to pending to firing. Then bring retrieval back.
#
#   docker compose -f deploy/compose/docker-compose.yml up --build -d
#   deploy/compose/prove-alerts.sh
set -euo pipefail

COMPOSE="docker compose -f $(dirname "$0")/docker-compose.yml"
PROM=${PROMETHEUS_URL:-http://127.0.0.1:9090}
ALERT=AssistantAvailabilityFastBurn
LIMIT_SECONDS=${LIMIT_SECONDS:-480}

state() {
  curl -fsS "$PROM/api/v1/alerts" | python3 -c "
import sys, json
alerts = [a for a in json.load(sys.stdin)['data']['alerts'] if a['labels']['alertname'] == '$ALERT']
print(alerts[0]['state'] if alerts else 'inactive')"
}
ratio() {
  curl -fsS --get "$PROM/api/v1/query" --data-urlencode 'query=slo:sli_error:ratio_rate5m{slo="assistant-availability"}' \
    | python3 -c "
import sys, json
r = json.load(sys.stdin)['data']['result']
print(r[0]['value'][1][:6] if r else 'no data')"
}

cleanup() { $COMPOSE start retrieval >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "before: $ALERT is $(state), 5m error ratio $(ratio)"
echo "stopping retrieval and asking questions for $((LIMIT_SECONDS / 60)) minutes at most"
$COMPOSE stop retrieval >/dev/null 2>&1
$COMPOSE run --rm -T smoke traffic "$LIMIT_SECONDS" >/tmp/prove-alerts-traffic.log 2>&1 &
TRAFFIC=$!

START=$(date +%s)
LAST=""
while :; do
  NOW=$(state)
  if [ "$NOW" != "$LAST" ]; then
    echo "+$(($(date +%s) - START))s  $ALERT: $NOW (5m error ratio $(ratio))"
    LAST=$NOW
  fi
  [ "$NOW" = "firing" ] && break
  if [ $(($(date +%s) - START)) -ge "$LIMIT_SECONDS" ]; then
    echo "the alert did not fire within $LIMIT_SECONDS seconds"
    kill "$TRAFFIC" 2>/dev/null || true
    exit 1
  fi
  sleep 5
done

echo "retrieval restarted; the alert will resolve once the 5 minute window clears"
kill "$TRAFFIC" 2>/dev/null || true
