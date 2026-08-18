#!/bin/bash
# Urgent fix for the endpoint-URL regression described in
# fix-endpoint-urls.py's docstring. Run this YOURSELF; your API key is
# prompted with hidden input, never taken as a CLI arg.
#
# Usage:
#   bash scripts/fix-endpoint-urls.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "n8n base URL (e.g. https://egx-n8n.onrender.com): "
read -r N8N_BASE_URL
if [ -z "$N8N_BASE_URL" ]; then
  echo "Required. Aborting."
  exit 1
fi

echo -n "n8n API key (input hidden): "
read -rs N8N_API_KEY
echo
if [ -z "$N8N_API_KEY" ]; then
  echo "Required. Aborting."
  exit 1
fi

export N8N_BASE_URL N8N_API_KEY
python3 scripts/fix-endpoint-urls.py
