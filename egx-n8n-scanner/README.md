# EGX N8N Scanner

An automated, quantitative end-of-day scanner for stocks listed on the Egyptian
Exchange (EGX), built entirely on **n8n** (orchestration, API client, scoring
engine, reporting engine) and **PostgreSQL** (all persistent state).

It is a measurement system, not a prediction oracle. Every score is a
**Bullish Setup Score**, **Momentum Score**, **Breakout Score**, or **Scanner
Rank** — a quantitative read on price/volume structure, evaluated against
subsequent market performance over time (`14-egx-prediction-evaluation`,
`15-egx-backtest`). Nothing in this project claims a stock is guaranteed to
rise. See [docs/SCORING.md](docs/SCORING.md).

---

## What it does

1. Retrieves and maintains the EGX stock universe.
2. Imports and maintains historical + daily OHLCV data.
3. Computes technical indicators (SMA/EMA/RSI/MACD/ATR/OBV/ROC/rolling
   highs-lows/relative volume) directly in JavaScript — no external TA
   library.
4. Detects price-structure support/resistance via swing-point clustering.
5. Runs four independent setup scanners — breakout, momentum, pullback,
   reversal — plus an accumulation signal.
6. Combines them into a configurable-weight overall score, ranks every
   liquid, active stock, and classifies its dominant setup type.
7. Publishes results through a read-only webhook API (`13-egx-report-api`).
8. Evaluates every past Top-N call against what actually happened the next
   session, and backtests the whole pipeline point-in-time (no look-ahead)
   over any historical date range.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full pipeline
diagram. In short:

```
01 Stock Universe ─┐
                    ├─▶ 03 Daily Market Update ─▶ [trading day?] ─▶ 04 Technical Analysis
                    │                                                  │
12 Daily Master ────┘                                                  ▼
Workflow (orchestrator)                                        05 Support/Resistance
                                                                        │
                                                                        ▼
                                                                 06 Volume Analysis
                                                                        │
                                              ┌─────────────┬──────────┼──────────┬─────────────┐
                                              ▼             ▼          ▼          ▼             │
                                        07 Breakout   08 Momentum 09 Pullback 10 Reversal        │
                                              └─────────────┴──────────┴──────────┴──────────────┘
                                                                        │
                                                                        ▼
                                                              11 Overall Ranking
                                                                        │
                                                                        ▼
                                                          13 Report API (webhooks)
                                                                        │
                                              14 Prediction Evaluation (T+1, daily) 
                                              15 Backtest (any historical range, on demand)
```

## Requirements

- Docker + Docker Compose (recommended), **or** a self-hosted n8n instance
  (n8n >= 1.60, any recent version with `httpRequest` v4.2 / `postgres` v2.5
  / `code` v2 node support) and PostgreSQL 14+ you manage yourself.
- An EGX-covering market data API key (EODHD, Twelve Data, or another
  provider — see [docs/DATA_PROVIDER.md](docs/DATA_PROVIDER.md)).

## Quick start (Docker)

```bash
cp env.example.txt .env
# edit .env: set POSTGRES_PASSWORD, N8N_ENCRYPTION_KEY, N8N_BASIC_AUTH_PASSWORD,
# REPORT_WEBHOOK_SECRET, MARKET_API_BASE_URL, MARKET_API_KEY

docker compose up -d
```

PostgreSQL runs the `sql/*.sql` migrations automatically on first boot (they're
mounted into `/docker-entrypoint-initdb.d`). n8n comes up on
`http://localhost:5678` (basic-auth protected).

If you're running against an **existing** Postgres instance instead, apply the
migrations yourself in order:

```bash
psql "$DATABASE_URL" -f sql/001-schema.sql
psql "$DATABASE_URL" -f sql/002-indexes.sql
psql "$DATABASE_URL" -f sql/003-views.sql
psql "$DATABASE_URL" -f sql/004-seed-settings.sql
```

## Import order

Full details, including exactly how to reconnect Execute Workflow references
after import (n8n reassigns workflow IDs on import), are in
[docs/IMPORT-N8N.md](docs/IMPORT-N8N.md). Summary:

1. Start PostgreSQL, run the SQL migrations (done automatically by Docker
   Compose).
2. Start n8n.
3. In n8n, create ONE PostgreSQL credential (any name — e.g. "EGX Postgres").
4. Set the environment variables from `env.example.txt` (Docker Compose reads
   `.env` automatically; a bare-metal n8n install needs them exported into
   n8n's process environment).
5. Import all 15 files from `workflows/` (Workflows → Import from File).
6. Open every `Postgres` node across all 15 workflows and assign your "EGX
   Postgres" credential (bulk-select isn't supported by n8n's import — this
   is a one-time, per-workflow chore).
7. Open every `Execute Workflow` node (in `12`, `15`) and reselect the target
   sub-workflow from the dropdown.
8. Edit the `HTTP Request` nodes marked `(CONFIGURE ENDPOINT)` in workflows
   `01`, `02`, `03` to match your market data provider's actual documented
   endpoints (see [docs/DATA_PROVIDER.md](docs/DATA_PROVIDER.md) — these ship
   as clearly labeled placeholders, not fabricated endpoints).
9. Run `01 - EGX Stock Universe` manually. Verify `stocks` populates.
10. Run `02 - EGX Historical Import` manually. This can take a while
    (`API_BATCH_SIZE` / `API_DELAY_MS` throttle it) — check `workflow_errors`
    afterward for any symbols that failed.
11. Run `04 - EGX Technical Analysis` manually **with `backfillAll: true`**
    (Execute Workflow input, or temporarily add a Set node before its
    trigger) to compute indicators across the whole imported history —
    otherwise it only computes the latest day.
12. Run `05 - EGX Support Resistance` the same way if you want historical
    support/resistance for backtesting.
13. Run `12 - EGX Daily Master Workflow` manually once to confirm the whole
    pipeline completes and produces a report.
14. Activate `12` (schedule) and `14` (schedule) from the n8n UI. Activate
    `13` (webhook) to expose the report API.

## Environment variables

See `env.example.txt` for the full, commented list (POSTGRES_*, n8n auth,
`MARKET_API_BASE_URL`/`MARKET_API_KEY`/`MARKET_DATA_PROVIDER`,
`HISTORICAL_DAYS`, `API_BATCH_SIZE`/`API_DELAY_MS`, the liquidity filter
(`MIN_AVG_TRADED_VALUE`/`MIN_AVG_VOLUME`/`MIN_ACTIVE_DAYS_20`),
`DAILY_SCAN_HOUR`/`DAILY_SCAN_MINUTE`, `TOP_N`, the breakout thresholds, and
`REPORT_WEBHOOK_SECRET`). No API key or password appears anywhere inside the
workflow JSON files — everything is read via `$env.*` expressions or left as
an unassigned n8n credential for you to configure after import.

`ANTHROPIC_API_KEY` is optional — powers `17 - EGX AI Assessment`'s "AI
Rank"/"AI Prob % T1" columns (see docs/SCORING.md "AI Assessment"). Leave
it blank and that workflow just no-ops; nothing else depends on it.

## Running the scanner

- **Manual, right now:** open `12 - EGX Daily Master Workflow` in n8n and
  click the Manual Trigger node ("Run EGX Scanner Now").
- **Scheduled:** activate `03`, `12`, and `14`. `03 - EGX Daily Market
  Update` retries every 30 minutes from 16:00-20:30 Africa/Cairo
  (Sunday-Thursday) purely to import EOD data as soon as EODHD publishes
  it — the publish time lags the ~14:30 close by a variable amount
  (confirmed via live testing: not yet available even at 17:00 on a normal
  trading day), so a single fixed time isn't reliable. `12`'s full scan
  then runs once at 21:00, and `14`'s prediction evaluation at 22:30, both
  after that retry window has had time to catch the data. n8n's Schedule
  Trigger reads its cron expression at registration time, not from env vars
  at runtime, so if you change `DAILY_SCAN_HOUR`/`DAILY_SCAN_MINUTE`, edit
  the node's cron expression to match.
- **Sub-workflow testing:** every sub-workflow (`01`-`11`) has its own Manual
  Trigger and can be run standalone for testing.

## Deploying to Render

`render.yaml` is a ready-to-use Render Blueprint (managed Postgres + n8n +
static dashboard, with the current scanned data pre-loaded) — see
[docs/RENDER_DEPLOY.md](docs/RENDER_DEPLOY.md) for the full walkthrough.

## Querying results

Once `13 - EGX Report API` is activated, its endpoints are live at
`{N8N_HOST}/webhook/egx/...` — full list, request/response shapes, and the
optional `Authorization: Bearer $REPORT_WEBHOOK_SECRET` requirement are in
[docs/WORKFLOWS.md](docs/WORKFLOWS.md#13---egx-report-api).

```bash
curl http://localhost:5678/webhook/egx/top
curl http://localhost:5678/webhook/egx/stock?symbol=COMI
curl -H "Authorization: Bearer $REPORT_WEBHOOK_SECRET" http://localhost:5678/webhook/egx/stocks
```

## Dashboard

`webapp/index.html` is a small, dependency-free (vanilla HTML/CSS/JS) dashboard
over the Report API — market regime header, a curated "Top 3 Trade Ideas" tab
(eligible Top 10 picks filtered to ≥5% potential gain to Target 1, fewer or
zero rows on a day nothing clears that bar), sortable Top 10 / per-setup /
full-market tables, and a stock detail drawer with reasons, sub-scores, moving
averages, and support/resistance. Docker Compose serves it via nginx at
`http://localhost:8090`. On first load, click **Settings** (gear icon) and set
the Report API base URL (defaults to `http://localhost:5678/webhook/egx`) and
the `REPORT_WEBHOOK_SECRET` bearer token if you set one — both are stored in
the browser's `localStorage`, never sent anywhere but your own n8n instance.

No build step: to run it standalone instead of via Docker Compose, just open
`webapp/index.html` directly or serve the folder with any static file server.

## Backtesting

```jsonc
// Execute Workflow input for 15-egx-backtest, or edit the defaults in its
// "Resolve Backtest Parameters" Code node for a Manual Trigger run:
{
  "startDate": "2026-01-01",
  "endDate": "2026-06-30",
  "minimumScore": 60,
  "setupType": "BREAKOUT",   // or "ANY"
  "topN": 10
}
```

Details on what it does and doesn't guarantee (daily-OHLC intraday-order
ambiguity, etc.) are in [docs/BACKTESTING.md](docs/BACKTESTING.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Postgres nodes fail immediately after import | Credential not assigned yet — see import step 6. |
| Execute Workflow nodes fail with "workflow not found" | Reselect the target workflow in the dropdown — see import step 7. |
| HTTP Request nodes return errors / no data | Endpoint URL still says `CONFIGURE-...-ENDPOINT` — see import step 8. |
| `03-egx-daily-market-update` reports `isTradingDay: false` every day | Provider `from`/`to` params or auth are wrong, OR it genuinely is a holiday — check `workflow_errors`. |
| `12` runs but produces an empty Top 10 | Liquidity filter (`MIN_AVG_TRADED_VALUE`/`MIN_AVG_VOLUME`) may be too strict for your universe, or `04`/`05`/`06` haven't been backfilled yet. |
| Webhook returns 401 | `REPORT_WEBHOOK_SECRET` is set — send `Authorization: Bearer <secret>`. |
| Scores all near 0 | Check `technical_analysis.data_confidence` for the stock — thin history intentionally suppresses confidence/eligibility rather than faking a strong reading. |
| Webhook 404/500 on `/stock`, `/stock/technicals`, `/stock/support-resistance` only | You're on an older export that used `:symbol` path params — those three endpoints now use `?symbol=` query params instead (see docs/WORKFLOWS.md's note on why). Re-sync/re-import `13-egx-report-api` and update any client calling the old URLs. |
| Dashboard shows "Failed to load: Unauthorized" | Click Settings, paste your `REPORT_WEBHOOK_SECRET` into the Bearer token field. |
| `13-egx-report-api` published but webhooks still 404 | On the newer draft/version n8n model, editing a workflow after publishing does NOT update the live routes — click **Publish** again. |

## Project layout

```
egx-n8n-scanner/
├── workflows/   15 importable n8n workflow JSON files
├── sql/         PostgreSQL schema, indexes, views, seed config
├── code/        Reference JS implementations mirrored into workflow Code nodes
├── docs/        Architecture, database, scoring, provider, backtesting, import docs
├── webapp/      Static dashboard (index.html) over the Report API
├── docker-compose.yml
├── env.example.txt   (copy to .env — named .txt to dodge this repo's .env* deny rule)
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
