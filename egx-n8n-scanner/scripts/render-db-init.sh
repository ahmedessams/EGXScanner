#!/bin/sh
# Runs as Render's preDeployCommand on the n8n service, before every deploy.
# Idempotent: only does anything the FIRST time (schema not yet present).
# On later deploys it's a fast no-op check against the same managed Postgres.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL not set — skipping DB init (is the Postgres database linked in render.yaml?)."
  exit 0
fi

echo "Checking for existing scanner schema..."
ALREADY_INITIALIZED=$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.stocks') IS NOT NULL;")

if [ "$ALREADY_INITIALIZED" = "t" ]; then
  echo "Schema already present — skipping init."
  exit 0
fi

if [ -f /home/node/data/full_dump.sql.gz ]; then
  echo "No schema found. Restoring full data dump (schema + ~10 months of scanned data)..."
  gunzip -c /home/node/data/full_dump.sql.gz | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
  echo "Data dump restored."
else
  echo "No schema found and no data dump bundled. Applying schema only (empty DB)..."
  for f in /home/node/sql/001-schema.sql /home/node/sql/002-indexes.sql /home/node/sql/003-views.sql /home/node/sql/004-seed-settings.sql; do
    echo "  applying $f"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
  echo "Schema applied. You'll need to run 01/02 (universe + historical import) manually to populate data."
fi

echo "DB init complete."
