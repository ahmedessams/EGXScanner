#!/bin/bash
# Sets ONE env var on a Render service via the API — an alternative to the
# dashboard's Environment tab, for when that page hangs/becomes
# unresponsive in the browser. Run this YOURSELF; your key and the value
# you type never leave your machine except going straight to api.render.com.
#
# Usage:
#   export RENDER_API_KEY="rnd_xxxxxxxxxxxxxxxxxxxxxxxx"
#   bash scripts/render-set-env.sh egx-n8n MARKET_API_BASE_URL
#   bash scripts/render-set-env.sh egx-n8n MARKET_API_KEY
#
# You'll be prompted for the value with input hidden (like a password
# prompt) so it doesn't land in your terminal's scrollback or shell
# history.
set -euo pipefail

if [ -z "${RENDER_API_KEY:-}" ]; then
  echo "Set RENDER_API_KEY first:"
  echo "  export RENDER_API_KEY=\"rnd_xxxxxxxxxxxxxxxxxxxxxxxx\""
  exit 1
fi

SERVICE_NAME="${1:-}"
ENV_KEY="${2:-}"
if [ -z "$SERVICE_NAME" ] || [ -z "$ENV_KEY" ]; then
  echo "Usage: bash scripts/render-set-env.sh <service-name> <ENV_VAR_KEY>"
  echo "Example: bash scripts/render-set-env.sh egx-n8n MARKET_API_KEY"
  exit 1
fi

BASE="https://api.render.com/v1"
AUTH_HEADER="Authorization: Bearer $RENDER_API_KEY"

echo "Finding service '$SERVICE_NAME'..."
SERVICE_ID=$(curl -s -H "$AUTH_HEADER" "$BASE/services?name=$SERVICE_NAME&limit=5" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data:
    if item['service']['name'] == sys.argv[1]:
        print(item['service']['id'])
        break
" "$SERVICE_NAME")

if [ -z "$SERVICE_ID" ]; then
  echo "Service '$SERVICE_NAME' not found on this account."
  exit 1
fi
echo "Found: $SERVICE_ID"

echo -n "Value for $ENV_KEY (input hidden): "
read -rs ENV_VALUE
echo
if [ -z "$ENV_VALUE" ]; then
  echo "Empty value — aborting."
  exit 1
fi

echo "Setting $ENV_KEY on $SERVICE_NAME..."
RESULT=$(python3 -c "import json,sys; print(json.dumps({'value': sys.argv[1]}))" "$ENV_VALUE" \
  | curl -s -X PUT \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "$BASE/services/$SERVICE_ID/env-vars/$ENV_KEY")

echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
key = d.get('key') or d.get('envVar', {}).get('key')
if key == '$ENV_KEY':
    print('Done: ' + key + ' is set (value not shown).')
else:
    print('Response:')
    print(json.dumps(d, indent=2))
"

echo
echo "Note: setting an env var via the API doesn't automatically restart"
echo "the service on every Render account tier — if egx-n8n doesn't pick it"
echo "up, trigger a manual deploy from the dashboard (Manual Deploy ->"
echo "Deploy latest commit) or re-run this for each var then redeploy once."
