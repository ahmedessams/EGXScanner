#!/bin/bash
# Automates the manual n8n setup steps in docs/RENDER_DEPLOY.md: creates the
# Postgres credential, imports all 15 workflows/*.json with it wired into
# every Postgres node, fixes cross-workflow references, and publishes
# everything in dependency order.
#
# Run this YOURSELF from the egx-n8n-scanner directory, after you've
# manually created the n8n owner account and generated an API key
# (n8n -> Settings -> API -> Create an API key). Your key and DB password
# are only ever sent to your own egx-n8n instance, and are prompted for
# with hidden input so they don't land in shell history.
#
# Usage:
#   cd egx-n8n-scanner
#   bash scripts/render-n8n-setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "n8n base URL (e.g. https://egx-n8n.onrender.com): "
read -r N8N_BASE_URL
if [ -z "$N8N_BASE_URL" ]; then
  echo "Required. Aborting."
  exit 1
fi

echo -n "n8n API key (Settings -> API -> Create an API key, input hidden): "
read -rs N8N_API_KEY
echo
if [ -z "$N8N_API_KEY" ]; then
  echo "Required. Aborting."
  exit 1
fi

echo
echo "Postgres connection details (from Render: egx-postgres -> Info tab,"
echo "or egx-n8n's Environment tab where they're already exposed)."
echo -n "  Host: "
read -r PG_HOST
echo -n "  Port [5432]: "
read -r PG_PORT
PG_PORT="${PG_PORT:-5432}"
echo -n "  Database: "
read -r PG_DATABASE
echo -n "  User: "
read -r PG_USER
echo -n "  Password (input hidden): "
read -rs PG_PASSWORD
echo

export N8N_BASE_URL N8N_API_KEY PG_HOST PG_PORT PG_DATABASE PG_USER PG_PASSWORD
python3 scripts/render-n8n-setup.py
