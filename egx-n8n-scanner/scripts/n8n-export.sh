#!/bin/bash
# Pulls every live n8n workflow back into workflows/*.json (the reverse of
# render-n8n-setup.sh) so edits made directly on the instance land in git
# instead of being reverted by the next re-sync. See n8n-export.py.
#
# Run this YOURSELF from the egx-n8n-scanner directory. The API key
# (n8n -> Settings -> API) is prompted with hidden input and only ever sent
# to your own n8n instance.
#
# Usage:
#   cd egx-n8n-scanner
#   bash scripts/n8n-export.sh
#   git diff --stat workflows/
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${N8N_BASE_URL:-}" ]; then
  echo -n "n8n base URL [https://egx-n8n.onrender.com]: "
  read -r N8N_BASE_URL
  N8N_BASE_URL="${N8N_BASE_URL:-https://egx-n8n.onrender.com}"
fi

if [ -z "${N8N_API_KEY:-}" ]; then
  echo -n "n8n API key (input hidden): "
  read -rs N8N_API_KEY
  echo
fi
if [ -z "$N8N_API_KEY" ]; then
  echo "Required. Aborting."
  exit 1
fi

export N8N_BASE_URL N8N_API_KEY
python3 scripts/n8n-export.py
