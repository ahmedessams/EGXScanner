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
Since 2026-09-02 the same node also computes two display-only companions
(see SCORING.md "Entry Quality"): `entry_quality_score` with its raw inputs
(`extension_atr`, `close_position_pct`, `rsi_slope3` — the query carries
`high`/`low` and `rsi14` from three sessions earlier for this) and
`relative_strength_20d` (20-day return minus the batch median 20-day
return, computed in-node across the same run's stocks). Neither moves
`overall_score` until it passes the scoring-lab two-slice bar.
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
"Prep for X" node — see ARCHITECTURE.md). After `11`, fans out to TWO
parallel branches (not sequential — `17` makes slower external API calls
and shouldn't gate the report): loads the Top 10 + market regime and
generates the plain-text daily report (section 24/53 format) as its final
output item's `reportText` field; and separately calls `17` for that same
Top 10.

## 17 - EGX AI Assessment

User-requested addition beyond the original spec. For each of that day's
Top 10 (`overall_rank <= 10`, eligible only — never the full 241-stock
universe, to keep this cheap), sends its technical/setup data to the
Anthropic Messages API with forced tool-use for structured JSON output,
asking for an independent probability estimate (reaching Target 1 within
`target1_estimated_days`) and a conviction score. `ai_rank` is then derived
locally by sorting that batch by conviction score — a second ranking shown
alongside `overall_rank`, not a replacement. Requires `ANTHROPIC_API_KEY`;
if unset/invalid/erroring, every row simply keeps NULL AI columns rather
than the workflow failing (confirmed via live testing with a mocked
auth-error response). See docs/SCORING.md "AI Assessment" for the full
methodology and the honesty framing around it (this is a model's judgment
call, not a statistic and not a guarantee). Callable standalone via Manual
Trigger for the latest date.

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

Since 2026-09-02 every row of `/stocks`, `/top` and `/top-picks` also
carries `relative_strength_20d`, `entry_quality_score` (+ `extension_atr`,
`close_position_pct`, `rsi_slope3`), `risk_pct` and `expected_value_pct`
(see SCORING.md "Entry Quality" / "Expected value"); `/top-picks` adds
`similar_expected_value_pct` from its similar-target cohort.

| Route | Notes |
|---|---|
| `GET /webhook/egx/stocks` | Full market table. `?sort=volume\|tradedvalue\|rvol\|score\|change`, `?date=YYYY-MM-DD` |
| `GET /webhook/egx/stocks/volume` | Sorted by raw volume. `?date=YYYY-MM-DD` |
| `GET /webhook/egx/stocks/relative-volume` | Sorted by RVOL20. `?date=YYYY-MM-DD` |
| `GET /webhook/egx/top` | Overall Top N (eligible only). `?limit=`, `?date=YYYY-MM-DD` |
| `GET /webhook/egx/top-picks` | Curated Top 3 trade ideas: eligible Top 10 picks that pass all three gates — ≥5% potential gain to Target 1; a measured ≥50% Target-1 hit rate on ≥20 past Top-10 picks of the same setup type with a similar-size target (0.6×–1.5×, same market, runs strictly before this one); AI P(T1) ≥40% when assessed. Capped at 3 rows, never lower than rank 10 — fewer (down to zero) on a day nothing clears the bar. Each row adds `similar_n`, `similar_target1_hit_pct`, `similar_stop_hit_pct`. Walk-forward check (2026-09-02): US 47.8%→61.8% hit, 17.4%→5.9% stop, mean realized +2.25%→+4.34% (34 of 69 picks kept); EGX neutral within noise (59.5%→61.5% hit, 15.0%→17.8% stop, +3.33%→+3.14%). `?date=YYYY-MM-DD`, `?market=` |
| `GET /webhook/egx/breakout` | Top N by breakout_score. `?date=YYYY-MM-DD` |
| `GET /webhook/egx/momentum` | Top N by momentum_score. `?date=YYYY-MM-DD` |
| `GET /webhook/egx/pullback` | Top N by pullback_score. `?date=YYYY-MM-DD` |
| `GET /webhook/egx/reversal` | Top N by reversal_score. `?date=YYYY-MM-DD` |
| `GET /webhook/egx/stock?symbol=SYMBOL` | Full stock detail (section 26 shape). `?date=YYYY-MM-DD` |
| `GET /webhook/egx/stock/technicals?symbol=SYMBOL` | Latest `technical_analysis` row (not date-aware) |
| `GET /webhook/egx/stock/support-resistance?symbol=SYMBOL` | Latest `support_resistance` row (not date-aware) |
| `GET /webhook/egx/market` | Latest market regime/score |
| `GET /webhook/egx/dates` | Distinct LIVE scan dates (newest first, max 90) — feeds the dashboard's date filter |

**`?date=YYYY-MM-DD` (spec: user-requested "date filter in each tab")**:
every route above except `/stock/technicals`, `/stock/support-resistance`,
and `/market` accepts it — including the stock detail drawer's `/stock`
endpoint (`market_snapshot($2)`, not `v_full_market` directly; the drawer
was otherwise always showing the latest date's data regardless of the
tab's active date filter, confirmed live). On-or-before semantics via
`market_snapshot(p_date)` / `scanner_run_as_of(p_date)`
(`sql/003-views.sql`) — picking a non-trading day (weekend/holiday) falls
back to the most recent prior trading day rather than erroring. Omitted or
invalid (anything not matching `YYYY-MM-DD`, validated server-side, never
concatenated into SQL) means "latest", identical to pre-filter behavior.
The ranked routes (`/top` and per-setup) return `{success:true,
results:[]}` for a date with no LIVE scan yet, rather than an empty HTTP
body — see the `alwaysOutputData` note on those endpoints in `13.js` if
you're extending this pattern elsewhere; a Postgres node's zero-row result
otherwise means every Code node downstream of it simply never executes
(confirmed via live E2E testing — see "A note on empty-input edges" below).

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

## 16 - EGX Target Window Evaluation

Distinct from `14`, which only looks at the single NEXT trading session.
Finds every eligible `scanner_results` row with a valid `target1`/
`invalidation_price`/`target1_estimated_days` and no `target_window_
evaluation` row yet, walks forward through real `daily_prices` up to that
row's own `target1_estimated_days` sessions, and records whichever
happened first: `TARGET1_HIT`, `STOP_HIT`, or (window fully elapsed with
neither touched) `EXPIRED_NO_HIT`. Rows without enough future price
history yet are left unevaluated and re-checked on the next run — never
guessed early. Then refreshes `probability_stats`, aggregated by
`setup_type`, which `v_scanner_top`/`v_full_market` join in to attach
`historical_target1_hit_pct`/`historical_stop_hit_pct`/
`historical_sample_size` to every current pick (see docs/SCORING.md
"Historical probability" for the full methodology and why grouping is
setup-type-only). Batches at 3000 rows per run like `14`/`15` — re-run to
catch up backlog. Not time-critical; scheduled weekly rather than daily.

**Multi-horizon labels** (2026-09-02, "Fill Multi-Horizon Labels" node): a
single hit/stop/expired outcome depends on the pick's own target and
window, so it cannot tell a pick that ran +4% and faded from one that never
moved. This node adds target-free labels to every `target_window_evaluation`
row in SQL: maximum favorable / adverse excursion (`mfe_Nd_pct` /
`mae_Nd_pct`, highest high / lowest low vs `entry_price`) over the first 1,
3, 5 and 10 sessions after the scan date, plus `ret_5d_pct` / `ret_10d_pct`
(close on session N vs entry). A horizon is filled only once that many
forward sessions exist; `horizon_bars` records how far the labels got, and
rows with `mfe_10d_pct IS NULL` are revisited each run (never-touched rows
first, up to 6000 per run) until the 10-session horizon closes. The summary
reports `horizonLabelsFilled` / `horizonLabelsCompleted`. Backfill over the
existing 37k rows took seven manual runs.

## A note on empty-input edges

Several workflows (`06`, `14`, and any per-item chain) will simply produce a
short, mostly-empty execution if their initial query returns zero rows (e.g.
`14` running before any scanner result is old enough to evaluate). This is
expected — not a bug — and is why every count/summary step downstream of a
branching IF is fed by BOTH branches (a `Join Branches` NoOp) so it still
fires even when one branch got nothing.
