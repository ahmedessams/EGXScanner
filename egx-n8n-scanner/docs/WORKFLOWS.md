# Workflows

All 15 workflows live in `workflows/*.json`, are directly importable, ship
`active: false`, and (except `13`, which is pure webhook) expose both a
Manual Trigger and an `Execute Workflow Trigger` so they can be tested
standalone or orchestrated by `12`/`15`.

## 01 - EGX Stock Universe

Fetches the exchange's symbol list (`HTTP Request` node, endpoint
placeholder — see [DATA_PROVIDER.md](DATA_PROVIDER.md)), normalizes it,
upserts into `stocks`, and deactivates any symbol not seen in the latest
fetch (`active = FALSE`). Invalid rows (missing symbol/name) are logged to
`workflow_errors` instead of failing the run.

## 02 - EGX Historical Import

Loads active stocks, then loops in batches of `API_BATCH_SIZE` (`Loop Over
Stocks (Batch)` / `SplitInBatches`), fetching `HISTORICAL_DAYS` sessions per
symbol, normalizing, validating (OHLC sanity, duplicate removal), and
upserting into `daily_prices`. A `Wait` node (`API_DELAY_MS`) throttles
between batches. Failed symbols/candles land in `workflow_errors` and do not
stop the import.

## 03 - EGX Daily Market Update

Same batched-fetch pattern as `02` but with a short (7-day) lookback so any
single missed day self-heals. Also optionally fetches EGX30 index candles
into `index_prices` (tolerant of failure). Finishes with `Verify Data
Completeness`, which counts how many active stocks actually got a row for
today and sets `isTradingDay` — `12` uses this to skip the rest of the
pipeline on holidays/weekends without guessing from the calendar.

## 04 - EGX Technical Analysis

For every active stock, loads price history up to `asOfDate` (as one JSON
array via `json_agg`), computes the full indicator set (`code/indicators.js`,
embedded), and upserts into `technical_analysis`. By default only writes the
latest row; pass `{"backfillAll": true}` to compute and persist the entire
historical series (needed once after `02`, before backtesting).

## 05 - EGX Support Resistance

Computes its own ATR14 from raw candles (doesn't depend on `04` having run),
detects swing highs/lows over the trailing `SUPPORT_RESISTANCE_LOOKBACK`
window, clusters them (ATR-normalized distance), scores cluster strength, and
upserts the 3 nearest supports/resistances into `support_resistance`. Also
supports `backfillAll`.

## 06 - EGX Volume Analysis

Per stock: computes `volume_change_1d/20d/50d_pct` and the accumulation
score (`code/volumeAnalysis.js`, needs a 15-session OBV/volume window),
requires `04` to have already populated `relative_volume20/50`. After every
stock is processed, `Build Market Rankings` (runs once over all collected
items) ranks the whole set by raw volume, traded value, RVOL20, RVOL50 —
this is the one workflow where a cross-sectional step happens AFTER the
per-item loop, not per item. Upserts into `volume_analysis`.

## 07 / 08 / 09 / 10 - The four scanners

Structurally identical (share `scannerCommon` data loading — see
`ARCHITECTURE.md`): `Get or Create Scanner Run` → load active stocks → for
each, `Load Snapshot` (last 25 sessions of price + indicators + today's
support/resistance) → derive fields (returns at 1/3/5/10/20 days, EMA50
5-day-rising, MACD crossover/improving, higher-highs/higher-lows,
sell-volume-declining, bullish-candle — all documented approximations, see
[SCORING.md](SCORING.md)) → call the matching `code/*Score.js` function →
upsert into `scanner_results`.

| Workflow | Module | Column | Extra output |
|---|---|---|---|
| 07 Breakout | `breakoutScore.js` | `breakout_score` | classification folded into `reasons_json` |
| 08 Momentum | `momentumScore.js` | `momentum_score` | — |
| 09 Pullback | `pullbackScore.js` | `pullback_score` | — |
| 10 Reversal | `reversalScore.js` | `reversal_score` | `positiveDivergence` always `false` in v1 |

## 11 - EGX Overall Ranking

Run LAST. Loads `scoring_weights`, then per stock: computes the liquidity
eligibility flag (`MIN_AVG_TRADED_VALUE`/`MIN_AVG_VOLUME`/
`MIN_ACTIVE_DAYS_20` over the trailing 20 sessions), builds the 9 weighted
factors (trend/volume/momentum/breakout/price-structure/MACD/RSI/relative-
strength/risk-reward — see [SCORING.md](SCORING.md) for exactly how each is
derived), calls `overallScore.js` for the composite, `classifySetupType`,
`calculateSetupConfidence`, and `riskReward.js` for the trade structure.
Upserts into `scanner_results`, then assigns `overall_rank` via a single
`RANK() OVER (ORDER BY overall_score DESC)` window-function `UPDATE`, then
computes market breadth (`marketRegime.js`, including an EGX30 index
component when `index_prices` has data) and finalizes the `scanner_runs` row
(`status = 'COMPLETED'`, `market_score`, `market_regime`,
`stocks_scanned`, `eligible_stocks`).

## 12 - EGX Daily Master Workflow

Schedule Trigger (`30 15 * * 0-4` — edit to match `DAILY_SCAN_HOUR`/
`DAILY_SCAN_MINUTE`, see [ARCHITECTURE.md](ARCHITECTURE.md) for why this
can't read the env vars directly) or Manual Trigger ("Run EGX Scanner Now").
Calls `01`, `03`, then gates on `isTradingDay`, then `04`→`05`→`06`→`07`→
`08`→`09`→`10`→`11` in sequence (each hop re-injects `{asOfDate}` via a
"Prep for X" node — see ARCHITECTURE.md), then loads the Top 10 + market
regime and generates the plain-text daily report (section 24/53 format) as
its final output item's `reportText` field.

## 13 - EGX Report API

12 GET webhook routes, each: `Webhook` → `Check Auth` (validates
`Authorization: Bearer $REPORT_WEBHOOK_SECRET` only if that env var is
non-empty — empty means the route stays public) → `IF Authorized?` → query
(parameterized, or built from a strict server-side whitelist for the one
user-controlled sort field) → format → `Respond to Webhook`. **Must be
activated for its production webhook URLs to respond** — on n8n versions
with the newer draft/version model (confirmed on 2.35.3 via live E2E
testing), this means clicking **Publish** (top-right), not a simple Active
toggle; older n8n versions use the Active toggle directly.

| Route | Notes |
|---|---|
| `GET /webhook/egx/stocks` | Full market table. `?sort=volume\|tradedvalue\|rvol\|score\|change` |
| `GET /webhook/egx/stocks/volume` | Sorted by raw volume |
| `GET /webhook/egx/stocks/relative-volume` | Sorted by RVOL20 |
| `GET /webhook/egx/top` | Overall Top N (eligible only). `?limit=` |
| `GET /webhook/egx/breakout` | Top N by breakout_score |
| `GET /webhook/egx/momentum` | Top N by momentum_score |
| `GET /webhook/egx/pullback` | Top N by pullback_score |
| `GET /webhook/egx/reversal` | Top N by reversal_score |
| `GET /webhook/egx/stock?symbol=SYMBOL` | Full stock detail (section 26 shape) |
| `GET /webhook/egx/stock/technicals?symbol=SYMBOL` | Latest `technical_analysis` row |
| `GET /webhook/egx/stock/support-resistance?symbol=SYMBOL` | Latest `support_resistance` row |
| `GET /webhook/egx/market` | Latest market regime/score |

**Why query params instead of the `:symbol` path param spec section 25 shows:**
confirmed via live E2E testing that this n8n build's PRODUCTION webhook router
requires the webhook node's internal random UUID to be prepended to the URL for
ANY webhook containing a dynamic `:param` path segment (e.g.
`/webhook/{uuid}/egx/stock/COMI`, not `/webhook/egx/stock/COMI`) — that UUID
regenerates on every re-import, so it can't be hardcoded into a portable
dashboard or documented URL. Static paths + query params route correctly and
portably regardless of n8n version.

## 14 - EGX Prediction Evaluation

Finds every `scanner_results` row with no `prediction_evaluation` row yet
AND at least one `daily_prices` row after its scan date, computes next-
session open/high/low/close-based metrics (return, MFE, MAE, target/stop
hits, `success`), and upserts. Idempotent and self-catching-up — safe to run
daily on a schedule regardless of backlog. Pass `{"runType": "BACKTEST"}`
(only `15` does this) to evaluate simulated runs instead of `LIVE` ones.

## 15 - EGX Backtest

Resolves `startDate`/`endDate`/`minimumScore`/`setupType`/`topN`, loads every
distinct `daily_prices.trading_date` in range, and loops (`SplitInBatches`,
batch size 1 — sequential by design) calling `04`→`05`→`06`→`07`→`08`→`09`→
`10`→`11` for EACH date with `runType: 'BACKTEST'`. After the loop, calls
`14` (to evaluate the backtest's own results) and runs its own aggregate
query (hit rates, MFE/MAE, return stats) scoped to `run_type = 'BACKTEST'`
AND the requested date range/score/setup filters — it deliberately does not
use `v_prediction_stats_by_setup` (see [DATABASE.md](DATABASE.md)). Expensive
— expect a multi-day backtest over hundreds of stocks to take a while.

## A note on empty-input edges

Several workflows (`06`, `14`, and any per-item chain) will simply produce a
short, mostly-empty execution if their initial query returns zero rows (e.g.
`14` running before any scanner result is old enough to evaluate). This is
expected — not a bug — and is why every count/summary step downstream of a
branching IF is fed by BOTH branches (a `Join Branches` NoOp) so it still
fires even when one branch got nothing.
