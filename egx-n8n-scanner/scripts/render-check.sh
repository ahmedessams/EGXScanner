#!/bin/bash
# Run this YOURSELF — your Render API key never leaves your machine, this
# repo, or gets sent anywhere but api.render.com.
#
# Usage:
#   export RENDER_API_KEY="rnd_xxxxxxxxxxxxxxxxxxxxxxxx"
#   bash scripts/render-check.sh
#
# What it does:
#   1. Finds egx-n8n / egx-db-init / egx-webapp service IDs on your account.
#   2. Prints the latest deploy status for egx-n8n and egx-webapp.
#   3. Lists egx-n8n's env var KEYS (never values) so you can confirm
#      MARKET_API_BASE_URL / MARKET_API_KEY are actually set.
#   4. Triggers a run of egx-db-init (restores data/full_dump.sql.gz into
#      egx-postgres) — safe to run more than once, it no-ops if the schema
#      already exists.
#
# What it deliberately does NOT do: create the n8n owner account, set up
# the Postgres credential, or import/publish workflows — those happen in
# n8n's own UI (docs/RENDER_DEPLOY.md has the exact steps) and can't be
# done via the Render API, which only manages infrastructure, not n8n's
# internal state.
set -euo pipefail

if [ -z "${RENDER_API_KEY:-}" ]; then
  echo "Set RENDER_API_KEY first:"
  echo "  export RENDER_API_KEY=\"rnd_xxxxxxxxxxxxxxxxxxxxxxxx\""
  exit 1
fi

BASE="https://api.render.com/v1"
AUTH_HEADER="Authorization: Bearer $RENDER_API_KEY"

echo "== Finding services =="
SERVICES_JSON=$(curl -s -H "$AUTH_HEADER" "$BASE/services?limit=20")

get_id() {
  echo "$SERVICES_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data:
    s = item['service']
    if s['name'] == sys.argv[1]:
        print(s['id'])
        break
" "$1"
}

N8N_ID=$(get_id egx-n8n)
DBINIT_ID=$(get_id egx-db-init)
WEBAPP_ID=$(get_id egx-webapp)

echo "egx-n8n:     ${N8N_ID:-NOT FOUND}"
echo "egx-db-init: ${DBINIT_ID:-NOT FOUND}"
echo "egx-webapp:  ${WEBAPP_ID:-NOT FOUND}"

if [ -z "$N8N_ID" ] || [ -z "$DBINIT_ID" ] || [ -z "$WEBAPP_ID" ]; then
  echo
  echo "One or more services weren't found. Has the Blueprint finished deploying"
  echo "at least once in the Render dashboard? Exiting."
  exit 1
fi

echo
echo "== Latest deploy status =="
for pair in "egx-n8n:$N8N_ID" "egx-webapp:$WEBAPP_ID"; do
  name="${pair%%:*}"
  id="${pair##*:}"
  status=$(curl -s -H "$AUTH_HEADER" "$BASE/services/$id/deploys?limit=1" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['deploy']['status'] if d else 'no deploys yet')")
  echo "$name: $status"
done

echo
echo "== egx-n8n env var keys (values are never printed) =="
curl -s -H "$AUTH_HEADER" "$BASE/services/$N8N_ID/env-vars?limit=100" | python3 -c "
import json, sys
data = json.load(sys.stdin)
keys = sorted(item['envVar']['key'] for item in data)
for k in keys:
    print(' -', k)
missing = [k for k in ('MARKET_API_BASE_URL', 'MARKET_API_KEY') if k not in keys]
if missing:
    print()
    print('MISSING (set these yourself in Render dashboard -> egx-n8n -> Environment):')
    for k in missing:
        print(' -', k)
"

echo
echo "== Triggering egx-db-init (restores the data dump) =="
RUN_JSON=$(curl -s -X POST -H "$AUTH_HEADER" "$BASE/cron-jobs/$DBINIT_ID/runs")
echo "$RUN_JSON" | python3 -m json.tool 2>/dev/null || echo "$RUN_JSON"
echo
echo "Render's API doesn't expose a polling endpoint for this run's status."
echo "Check completion in the dashboard: egx-db-init -> Logs (look for"
echo "\"DB init complete\" or \"Schema already present - skipping init.\")."

echo
echo "== Done =="
echo "Remaining steps are manual, in n8n's own UI (the Render API can't do"
echo "these — it only manages infrastructure, not n8n's internal state):"
echo "  1. Open egx-n8n's URL, create the owner account."
echo "  2. Credentials -> New -> Postgres, pointing at egx-postgres."
echo "  3. Import all 15 workflows/*.json, assign that credential to every"
echo "     Postgres node."
echo "  4. Publish in order: 01, 03-11, then 12, 13, 14, 15."
echo "  5. Activate 03, 12, 14."
echo "See docs/RENDER_DEPLOY.md for the full walkthrough."
