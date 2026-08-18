#!/bin/sh
# ENTRYPOINT of the egx-db-init Render cron job (Dockerfile.dbinit).
# Trigger it manually ("Trigger Run" in Render's dashboard) once, right
# after the Blueprint's first deploy — see docs/RENDER_DEPLOY.md.
# Idempotent: safe to trigger again later, it just no-ops if the schema is
# already present.
set -e
cd "$(dirname "$0")"

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL not set — is the Postgres database linked in render.yaml?"
  exit 1
fi

echo "Checking for existing scanner schema..."
ALREADY_INITIALIZED=$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.stocks') IS NOT NULL;")

if [ "$ALREADY_INITIALIZED" = "t" ]; then
  echo "Schema already present — skipping init."
  exit 0
fi

if [ -f data/full_dump.sql.gz ]; then
  echo "No schema found. Restoring full data dump (schema + ~10 months of scanned data)..."
  gunzip -c data/full_dump.sql.gz | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
  echo "Data dump restored."
else
  echo "No schema found and no data dump bundled. Applying schema only (empty DB)..."
  for f in sql/001-schema.sql sql/002-indexes.sql sql/003-views.sql sql/004-seed-settings.sql; do
    echo "  applying $f"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
  echo "Schema applied. You'll need to run 01/02 (universe + historical import) manually to populate data."
fi

echo "DB init complete."
