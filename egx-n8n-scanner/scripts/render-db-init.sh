#!/bin/sh
# ENTRYPOINT of the egx-db-init Render cron job (Dockerfile.dbinit).
# Trigger it manually ("Trigger Run" in Render's dashboard) after the
# Blueprint's first deploy — see docs/RENDER_DEPLOY.md — and again any
# time sql/*.sql changes (new tables/views/seed data), since every file in
# that set is written to be idempotent (CREATE TABLE IF NOT EXISTS,
# CREATE OR REPLACE VIEW, ON CONFLICT upserts) and safe to re-apply.
set -e
cd "$(dirname "$0")"

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL not set — is the Postgres database linked in render.yaml?"
  exit 1
fi

echo "Checking for existing scanner schema..."
ALREADY_INITIALIZED=$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.stocks') IS NOT NULL;")

if [ "$ALREADY_INITIALIZED" != "t" ] && [ -f data/full_dump.sql.gz ]; then
  echo "No schema found. Restoring full data dump (schema + ~10 months of scanned data)..."
  gunzip -c data/full_dump.sql.gz | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
  echo "Data dump restored."
fi

echo "Applying sql/001-005 (idempotent — picks up any new tables/views/seed data)..."
for f in sql/001-schema.sql sql/002-indexes.sql sql/003-views.sql sql/004-seed-settings.sql sql/005-seed-us-universe.sql; do
  echo "  applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "DB init/migration complete."
