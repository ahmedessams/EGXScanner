# Database

Schema lives in `sql/001-schema.sql` (tables), `sql/002-indexes.sql`,
`sql/003-views.sql`, and `sql/004-seed-settings.sql` (default scoring weights
+ non-secret app settings). Apply in that order — Docker Compose does this
automatically on first boot via `/docker-entrypoint-initdb.d`.

## Tables

| Table | Purpose | Unique key |
|---|---|---|
| `stocks` | EGX stock master data | `(exchange, symbol)` |
| `daily_prices` | OHLCV history | `(stock_id, trading_date)` |
| `technical_analysis` | Computed indicators per stock/date | `(stock_id, trading_date)` |
| `support_resistance` | Clustered swing levels per stock/date | `(stock_id, trading_date)` |
| `volume_analysis` | Volume-change %, rankings, accumulation score per stock/date | `(stock_id, trading_date)` |
| `scoring_weights` | Configurable overall-score weights | `(profile_name, factor)` |
| `app_settings` | Non-secret runtime config (JSONB value) | `key` |
| `scanner_runs` | One row per scan execution (LIVE/BACKTEST/MANUAL) | `(trading_date, run_type)` |
| `scanner_results` | Per-stock scoring output for a `scanner_run` | `(scanner_run_id, stock_id)` |
| `prediction_evaluation` | T+1 outcome for a `scanner_results` row | `(scanner_result_id)` |
| `workflow_errors` | Non-fatal per-item errors from any workflow | — |
| `index_prices` | Optional EGX30 (or other) index history | `(index_code, trading_date)` |

`volume_analysis` and `scoring_weights`/`app_settings` are additions beyond
the strict spec table list — the spec requires the computed values they hold
(RVOL rankings, accumulation score, configurable weights) to exist somewhere
queryable by the ranking/scanner workflows and the report API; giving them
dedicated tables was more correct than bolting them onto `scanner_results`
(which is scoped to a `scanner_run`, not a bare stock/date) or hardcoding
weights inside a Code node.

## Why `scanner_results` is populated by five different workflows

`07`-`10` (the four independent scanners) each `INSERT ... ON CONFLICT
(scanner_run_id, stock_id) DO UPDATE` their own score column
(`breakout_score`, `momentum_score`, etc.) and append their own entries into
`reasons_json`/`warnings_json` (JSONB concatenation, not overwrite — see the
`||` in each workflow's upsert query). `11` reads all four back plus
`accumulation_score` from `volume_analysis`, and is the only workflow that
sets `overall_score`, `setup_type`, `overall_rank`, `eligible`,
`entry_price`/`invalidation_price`/`target1-3`, and the risk/reward columns.
This lets each scanner run and be tested completely independently while
still converging on one row per stock per scan.

`11` also writes the 2026-09-02 display-only companions (append-only `ALTER
TABLE ... ADD COLUMN IF NOT EXISTS` in `001-schema.sql`, so an existing
database upgrades in place): `relative_strength_20d` (20-day return minus
the run's median 20-day return), `entry_quality_score` and its inputs
`extension_atr` / `close_position_pct` / `rsi_slope3`. They are stored per
pick precisely so they can be scored against realized outcomes
(`target_window_evaluation`) before either is allowed to move the ranking.

`target_window_evaluation` carries, besides the single hit/stop/expired
outcome, target-free multi-horizon labels filled by `16`: `mfe_{1,3,5,10}d_pct`
/ `mae_{1,3,5,10}d_pct` (max favorable / adverse excursion vs `entry_price`
over the first N sessions after the scan date), `ret_5d_pct` / `ret_10d_pct`
(close on session N vs entry), `horizon_bars` (how many forward sessions
existed when last labelled — a horizon stays NULL until it can close) and
`labels_updated_at`. `expected_value_pct` / `risk_pct` are NOT stored: the
views derive them from the pick's stored gain/stop and the current
`probability_stats` base rates.

## Views

- `v_latest_scanner_run` — the most recent completed `LIVE` run.
- `v_latest_prices` — latest `daily_prices` row per stock, with
  `previous_close`/`change_pct` computed via a `LATERAL` join.
- `v_full_market` — one row per active stock joining latest price,
  indicators, support/resistance, volume analysis, and (if a `LIVE` run
  exists) that stock's scanner results. Backs `GET /webhook/egx/stocks` and
  its sort variants.
- `v_scanner_top` — flattened `scanner_results` + stock/price/indicator
  context for a given `scanner_run_id`. Backs the Top-N and per-setup
  endpoints.
- `v_prediction_stats_by_setup` — aggregate hit-rate/return statistics
  grouped by `setup_type` across ALL `prediction_evaluation` rows (both LIVE
  and BACKTEST). If you want backtest-only statistics for a specific date
  range, query `prediction_evaluation` joined through `scanner_runs` directly
  (this is exactly what `15-egx-backtest`'s "Aggregate Backtest Metrics" node
  does — it does not use this view, precisely because the view doesn't scope
  by run_type or date range).

## No look-ahead, enforced by schema + query shape

Every per-stock computation (`technical_analysis`, `support_resistance`,
`volume_analysis`, and every scanner) is queried with `trading_date <=
$asOfDate` (or `= $asOfDate` for same-day joins) — never an unbounded read.
`prediction_evaluation` is the one place FUTURE data is deliberately read,
and only for dates strictly after the scan date, and only once that future
data actually exists (see `14-egx-prediction-evaluation`'s `EXISTS` clause).
See [BACKTESTING.md](BACKTESTING.md) for how this is validated end to end.

## Future ML export

`technical_analysis`, `support_resistance`, and `volume_analysis` together
carry every feature named in spec section 51 (RSI, MACD, EMA distances,
RVOL, ATR, momentum, support/resistance distance, sector via `stocks.sector`,
volume changes, prior returns via `roc5/10/20`) keyed by `(stock_id,
trading_date)`, and `prediction_evaluation` carries the corresponding labels
(`return_previous_close_to_close_pct`, `maximum_favorable_excursion_pct`,
`maximum_adverse_excursion_pct`, `target1_hit`). A feature/label export is a
straight join on `stock_id` + `trading_date` — no schema changes needed to
start building a training set later.
