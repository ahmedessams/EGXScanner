# Importing into n8n

## Exact order

```
1. Start PostgreSQL (docker compose up -d postgres, or your own instance)
2. Run SQL migrations (automatic via Docker Compose; otherwise psql -f sql/001..004 in order)
3. Start n8n
4. Create ONE PostgreSQL credential in n8n (Credentials → New → Postgres)
5. Set environment variables (.env for Docker Compose; process env for bare-metal n8n)
6. Import all 15 files from workflows/ (Workflows → Import from File, one at a time
   or via n8n's "Import from File" multi-select if your version supports it)
7. Assign the Postgres credential to every Postgres node, in every workflow
8. Reconnect every Execute Workflow node's target (workflows 12 and 15)
9. Edit the (CONFIGURE ENDPOINT) HTTP Request node URLs (workflows 01, 02, 03)
10. Run 01 manually — verify `stocks` populates
11. Run 02 manually — verify `daily_prices` populates; check workflow_errors
12. Run 04 with {"backfillAll": true} — verify `technical_analysis` populates historically
13. Run 05 with {"backfillAll": true} if you plan to backtest
14. Run 12 manually — verify the full pipeline completes and produces a report
15. Activate 12 (schedule) and 14 (schedule); activate 13 (webhook)
```

## Why credentials and workflow references can't ship pre-wired

Two things n8n generates at import time, not before:

- **Credential IDs** are specific to the n8n instance they were created in.
  Shipping a workflow JSON with a hardcoded credential ID would either
  silently point at nothing (safe but useless) or, worse, coincidentally
  point at someone else's real credential with the same ID on a shared
  instance. Every Postgres node in this project ships with NO `credentials`
  block at all — n8n will show a small warning badge on each one until you
  assign your credential. This is intentional, not an oversight.

- **Workflow IDs** are reassigned on every import — the ID `01-egx-stock-
  universe.json` had when exported is not the ID it gets when you import it.
  `Execute Workflow` nodes (in `12-egx-daily-master-workflow` and
  `15-egx-backtest`) reference their target by `{ mode: "list", value: "" }`
  with a `cachedResultName` matching the target workflow's name — the `value`
  ships empty on purpose. Open each Execute Workflow node after import and
  use the dropdown (it searches by name, so typing "07" or "Breakout" will
  find `07 - EGX Breakout Scanner`) to pick the actual imported workflow.

## Assigning the Postgres credential to every node

There is no bulk-assign across an entire workflow in the n8n UI as of this
writing. For each of the 15 workflows:

1. Open the workflow.
2. Click each node with the Postgres icon.
3. Under "Credential for Postgres", select your credential (create it once,
   reuse everywhere).
4. Save the workflow (Ctrl/Cmd+S).

Workflow `13-egx-report-api` has the most Postgres nodes (12, one per
endpoint) — budget a few minutes for it specifically.

## Reconnecting Execute Workflow nodes

| Workflow | Execute Workflow nodes to fix |
|---|---|
| `12-egx-daily-master-workflow` | `Execute: 01 Stock Universe`, `Execute: 03 Daily Market Update`, `Execute: 04 Technical Analysis`, `Execute: 05 Support Resistance`, `Execute: 06 Volume Analysis`, `Execute: 07 Breakout Scanner`, `Execute: 08 Momentum Scanner`, `Execute: 09 Pullback Scanner`, `Execute: 10 Reversal Scanner`, `Execute: 11 Overall Ranking` |
| `15-egx-backtest` | `Execute: 04 Technical Analysis` through `Execute: 11 Overall Ranking`, plus `Execute: 14 Prediction Evaluation` |

Each node's dropdown is pre-populated with the correct target NAME (matching
the `name` field inside each workflow JSON, e.g. `"07 - EGX Breakout
Scanner"`) — you're just resolving name → ID, not guessing which workflow it
should be.

## Environment variables reaching n8n

- **Docker Compose**: `docker-compose.yml` passes every scanner-specific
  variable through explicitly under the `n8n` service's `environment:` block,
  sourced from `.env`. Nothing extra to do beyond having a correct `.env`.
- **Bare-metal / self-hosted n8n**: export the variables from
  `env.example.txt` into the process environment n8n itself runs under (or
  your n8n instance's own `.env` mechanism, if it has one) BEFORE starting
  n8n — Code/HTTP/Postgres nodes read them via `$env.VAR_NAME`, which only
  sees variables n8n's own process had at startup.

## Activating schedules and webhooks

Workflows import as `active: false` deliberately (spec section 33) — nothing
starts firing until you review it. When ready:

- On n8n's classic Active-toggle model: flip the toggle next to the
  workflow name (top right of the editor).
- On n8n's newer draft/version model (confirmed on 2.35.3 via live E2E
  testing — look for a **Publish** button instead of a toggle): click
  **Publish**, give the version a name, and confirm. Re-publish after any
  edit to a workflow you've already published — the published version is a
  snapshot, not a live pointer to the draft.

Apply whichever mechanism your n8n build has to:
- `12-egx-daily-master-workflow`: activates the Schedule Trigger. Confirm
  its cron expression matches your intended `DAILY_SCAN_HOUR`/
  `DAILY_SCAN_MINUTE` (n8n can't read env vars into a cron expression at
  registration time — see `docs/ARCHITECTURE.md`).
- `14-egx-prediction-evaluation`: activates the daily evaluation schedule.
- `13-egx-report-api`: webhook nodes only respond on their PRODUCTION URL
  once active/published (the "Listen for test event" button in the editor
  only captures ONE call at a time, for debugging).

## Sanity-checking after import

```sql
-- After step 10 (workflow 01):
SELECT COUNT(*) FROM stocks WHERE active = TRUE;

-- After step 11 (workflow 02):
SELECT COUNT(*), MIN(trading_date), MAX(trading_date) FROM daily_prices;
SELECT * FROM workflow_errors ORDER BY occurred_at DESC LIMIT 20;

-- After step 14 (workflow 12, full run):
SELECT * FROM scanner_runs ORDER BY started_at DESC LIMIT 1;
SELECT symbol, overall_score, setup_type, overall_rank
FROM v_scanner_top
WHERE scanner_run_id = (SELECT id FROM v_latest_scanner_run)
ORDER BY overall_rank LIMIT 10;
```
