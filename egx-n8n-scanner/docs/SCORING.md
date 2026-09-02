# Scoring Methodology

**Terminology contract:** this system produces a *Bullish Setup Score*,
*Momentum Score*, *Breakout Score*, *Expected Setup Strength*, *Historical
Probability*, and *Scanner Rank*. It never claims a *guaranteed* profit,
increase, or prediction. Every number here is a measurement of present
price/volume structure plus a historical track record from
`prediction_evaluation` — not a forecast.

## Indicators (`code/indicators.js`)

Standard implementations (SMA, EMA seeded from SMA, Wilder-smoothed RSI14,
MACD 12/26/9, Wilder-smoothed ATR14, cumulative OBV, ROC, rolling
high/low). All null-safe: insufficient history produces `null`, never `NaN`
or a fabricated `0`. Candles are always sorted oldest→newest before any
calculation (`helpers.sortCandlesAscending`).

**Relative volume** (`relativeVolume(volumes, period)`): today's volume
divided by the average of the PRIOR `period` sessions — today is never
included in its own denominator (spec section 9/30). `volume_change_vs_20d_pct`
in `06-egx-volume-analysis` is `(RVOL20 - 1) * 100`, algebraically identical
to comparing today's volume against that same prior-20-session average.

**Trend classification** (`classifyTrend`): short-term from
close/EMA9/EMA20, medium-term from close/EMA20/EMA50, long-term from
close/EMA50/EMA200 — but long-term is left `null` (not `BEARISH`) when
EMA200 isn't computable yet, so a newly-listed stock's thin history doesn't
read as structurally weak.

**Data confidence** (per `technical_analysis` row): `min(100, barsOfHistory
/ 252 * 100)` — a stock with 60 days of history caps at ~24% confidence
regardless of how clean its indicators look, because 60 days isn't enough to
trust a full-cycle read.

**Horizon estimates** (`horizonEstimates(closes)`): the standard
drift + volatility ("expected move") framework professionals use when only
price data is available. Over the trailing 252 sessions (at least 60 valid
daily log returns required, else `null`), measure the stock's own mean daily
log return (drift, μ) and its standard deviation (volatility, σ). The
central estimate for a horizon of h trading days is `close × e^(μ·h)`,
stored as `est_2w_pct` / `est_1m_pct` / `est_3m_pct` / `est_1y_pct`
(h = 10/21/63/252) alongside `drift_annual_pct` and
`volatility_annual_pct`; the dashboard derives prices and the ±1σ·√t
uncertainty band from these. This is a projection of the stock's own
measured history — it can be negative for weak stocks by construction, it
is NOT a forecast, and the band widens with √t, so the 3-month and
especially 1-year numbers are context, not predictions. Surfaced as
hidden-by-default table columns and a "Horizon Estimates" drawer section.

**Long-term technical quality** (`longTermTechScore`, `long_term_score`,
"LT Score"): a price-only durable-uptrend read for LONG holding horizons,
deliberately separate from the four setup scanners (which hunt short-term
entries). Components: trend position (30 — close above SMA200 + SMA200
higher than 63 sessions ago), consistency (20 — share of the last 252
sessions closing above their own SMA200), drawdown resilience (20 — scaled
distance below the 52-week high, zero at 30%+ below), long-horizon returns
(15 — positive 12-month + positive 6-month), volatility discipline (15 —
full marks at ≤30% annualized, zero at 90%+). Null until SMA200 exists.
The weights and thresholds are an UNTUNED, non-backtested heuristic — a
screening aid, not a forecast, and not investment advice.

**Dividend signals** (`dividends` table, weekly import from the provider's
`/div` endpoint by `20 - EGX Dividend Import`): trailing-12-month dividend
sum and yield vs the row's close (`dividend_yield_pct`), distinct calendar
years with a payout among the last 5 (`dividend_years_paid_5y`), and TTM
growth vs the prior TTM (`dividend_growth_pct`) — all derived in the views
at read time, nothing precomputed to go stale. Dividend `value` is the
provider's split-adjusted per-share amount. These are measured payout
history, the closest a price-feed-only system gets to a fundamentals
quality screen; the full valuation screen (P/E, ROE, EV/EBITDA) requires
the provider's Fundamentals subscription, which returns 403 on the current
plan (checked 2026-09-01).

## Support/Resistance (`code/supportResistance.js`)

Swing highs/lows via a 5-bar fractal (2 bars each side must be strictly the
local max/min). Candidate levels are clustered by ATR-normalized distance
(0.5×ATR14, falling back to 0.5% of price when ATR isn't available) — three
levels like 10.01/10.04/10.07 collapse into one zone rather than three
separate resistances. Cluster strength (0-100) weights touch count (40%),
recency (25%), touch time-separation (20% — spread-out touches read as more
"tested" than one noisy consolidation), and volume presence (15%). The most
recent `wing` (2) bars of any window never produce a confirmed swing point,
by construction — there's no future bar to compare against yet, so this
can't introduce look-ahead bias even if a caller passes too-recent data.

## Volume analysis (`code/volumeAnalysis.js`)

Cross-sectional rankings (`rankBy`) sort descending by raw volume, traded
value, RVOL20, RVOL50 — rows with no numeric value for that field rank last,
never crash the sort. **Accumulation score** (0-100) blends six independent
signals over a 10+ bar window (OBV trend 25%, price flatness 15%, volume
expansion between the window's two halves 25%, average close-position-within
-day's-range 15%, fraction of up/flat days 10%, traded-value trend 10%) —
each sub-factor is independently clamped to `[0,1]` before weighting, so the
final score can never leave `[0,100]` regardless of the instrument's price
scale.

## The four independent scanners

Each returns `{ score (0-100), reasons[], warnings[] }` (breakout also
returns a `classification`). They are DELIBERATELY inconsistent with each
other on what "good RSI" or "good recent return" means — that's the point:

| Signal | Breakout | Momentum | Pullback | Reversal |
|---|---|---|---|---|
| RSI 55-70 | reward | — | — | — |
| RSI 65-72 | — | reward | — | — |
| RSI 40-55 | — | — | **reward** (cooled off) | — |
| RSI < 30 | — | — | caution | **reward** (oversold) |
| Negative 1-day return | neutral | penalized via overextension logic | **never disqualifies** | context only |
| RVOL spike | breakout confirmation | momentum confirmation | — | possible capitulation signal |

**Breakout** (`breakoutScore.js`): proximity to/breach of resistance (25pt),
RVOL vs `BREAKOUT_MIN_RVOL`/`BREAKOUT_STRONG_RVOL` (25pt), EMA9>EMA20>EMA50
structure (20pt), MACD (10pt), RSI band (10pt), at/near 20-session high
(10pt). Classifies `BREAKOUT_CONFIRMED` only when close clears resistance by
an ATR-or-percentage buffer (never a bare cross, to reduce false breakouts),
`BREAKOUT_WATCH` within `BREAKOUT_DISTANCE_PCT`, else `NO_BREAKOUT`.

**Momentum** (`momentumScore.js`): weighted 1/3/5/10/20-day returns (30pt,
each horizon saturating around +8%), EMA stack (20pt), MACD (15pt), RSI band
tuned for continuation rather than breakout (10pt), RVOL (10pt),
higher-highs/higher-lows (10pt) — MINUS an overextension penalty (up to
20pt) when price is more than 2.5×ATR above EMA20, so an already-extended
name doesn't get rewarded further just for being extended.

**Pullback** (`pullbackScore.js`): medium-term trend intact — EMA20>EMA50
and EMA50 rising (30pt) — proximity to EMA20/support (up to 35pt: 15pt
EMA20 proximity + 15pt support proximity + a separate +5pt bonus when the
nearby support level itself has a strength score ≥ 50), RSI cooled into
40-55 (20pt), declining sell-side volume on down days (15pt). A negative
daily return is logged as context, never a penalty.

**Reversal** (`reversalScore.js`): oversold RSI (up to 30pt: 25pt for the
RSI band itself + a separate +5pt bonus when RSI is turning up off a low
base), support proximity (20pt), volume spike (20pt, read as possible
capitulation rather than confirmation), bullish candle structure (10pt),
MACD improving (15pt), positive RSI divergence (10pt) — **left
`false`/unused in v1**, because robust divergence detection needs more
history-aware peak/trough matching than is worth the false-positive risk
here; treat it as a documented gap, not a hidden claim. These section maxes
sum to 105, not 100, so the final `clamp(0,100)` can compress two distinct
strong reversal setups (e.g. one hitting every bonus vs. one just short) to
the same ceiling — a known, not-yet-rebalanced gap flagged here rather than
silently hidden behind the clamp; correcting it changes score distribution
and belongs in a deliberate, backtested tuning pass, not a doc fix.

## Overall score (`code/overallScore.js`)

NOT a flat average of the four scanner scores — different setup types
aren't comparable on the same raw scale. Instead, 9 independently-derived
factors are combined with configurable weights (`scoring_weights` table,
defaults: trend 20 / volume 20 / momentum 15 / breakout 15 / price-structure
10 / MACD 5 / RSI 5 / relative-strength 5 / risk-reward 5, editable without
touching any workflow):

- **trend** — `medium_term_trend` classification mapped to 0/25/50/75/100.
- **volume** — RVOL20 scaled `(rvol/3)*100`, clamped.
- **momentum** — `momentum_score` directly.
- **breakout** — `breakout_score` directly.
- **price_structure** — `100 - min(100, nearest_resistance_distance_pct * 10)`.
- **macd** — MACD histogram sign/magnitude scaled around 50.
- **rsi** — approximated from `momentum_score` in `11` (RSI itself isn't
  re-fetched at that stage since momentum's RSI read is already a decent
  proxy for "is momentum/RSI supportive right now" — a documented
  simplification, not a re-derivation of the RSI banding tables above).
- **relative_strength** — 20-day return scaled around 50 (`50 + ret20d × 3`,
  clamped), a vs-flat proxy. The **market-relative** version — the stock's
  20-day return minus the same-day MEDIAN 20-day return of the market's
  active universe — is computed in the same node since 2026-09-02 and
  stored as `scanner_results.relative_strength_20d` (API/dashboard "RS vs
  Mkt"), but it is *not* the ranking input until it clears the two-slice
  lab bar described under Risk/reward (lab variants `V10`–`V12`,
  `V15`). The benchmark is the universe median rather than the index
  because `index_prices` has no history before Aug 2026. **Lab verdict
  2026-09-02: neutral on both markets** — EGX BACKTEST hit 48.0–48.6% vs
  48.2% baseline, LIVE 50.0–51.2% vs 50.0%; US BACKTEST 21.5–22.2% vs
  21.7%, LIVE 26.1–26.5% vs 26.5%. Realized return and expectancy moved
  within ±0.1 pt in both directions. Not shipped as a ranking input.
- **risk_reward** — `riskRewardT1` scaled, 0 if no valid R:R exists.

## Entry Quality (`code/entryQuality.js`)

The setup score answers "is this a good stock to be in?"; Entry Quality
answers the separate question "is TODAY a good day to get in?". A strong
setup that has already run 3 ATR above its EMA20 and closed at the low of a
wide bar is a good stock and a bad entry, and one number cannot say both.
Computed in workflow 11's scoring node alongside the overall score, stored
per pick (`entry_quality_score` plus its three raw inputs `extension_atr`,
`close_position_pct`, `rsi_slope3`) and shown next to the setup score on
`/top`, `/top-picks`, `/stocks` and in the dashboard. Three parts, 0–100:

- **Extension vs trend (40 pts)** — `(close − EMA20) / ATR14`. Full marks in
  the −0.5 … +1.0 ATR band; fades linearly to 0 at +3 ATR (chasing) and at
  −2 ATR (falling knife).
- **Close position in range (30 pts)** — `(close − low) / (high − low)` ×
  30. A close near the high says buyers finished the day in control.
- **RSI 3-session slope (30 pts)** — `15 + (rsi14 − rsi14 three sessions
  ago) × 1.5`, clamped 0–30. Momentum building, not fading.

A missing input sits at its midpoint rather than at 0, so a stock with no
EMA yet is "unknown", not "bad". **Display-only for now**: it is not a
ranking factor. Blending it into the score is variants `V13`/`V14`/`V15`
in `scripts/scoring-lab.js` and only ships if both slices improve.

**Lab verdict 2026-09-02: the blend HURTS.** EGX (64 dates, 510 backtest
/ 82 live Top-10 picks): 10% blend took BACKTEST hit 48.2 → 47.6% and LIVE
50.0 → 46.3% with the live stop rate up 15.9 → 18.3% and mean realized
+2.19 → +1.39%; 20% blend was worse still (45.5% / 47.6%, live median
gain-to-T1 9.65 → 5.96%). US (54 dates, 437 / 68): backtest improved
marginally (fwd-10 mean −0.79 → −0.45/−0.19%) but LIVE hit fell 26.5 →
23.5% (10%) and 19.1% (20%) with expectancy −0.055 → −0.079/−0.140 R —
fails the two-slice rule. The likely reason: Entry Quality rewards
"already moving" (close near high, rising RSI), which overlaps with the
momentum score and de-ranks the pullback-type entries that actually
carried the EGX edge. It stays a separate displayed number, which is
what it was designed to be.

## Expected value (`expected_value_pct`)

`EV = P(T1) × gain_to_T1 − P(stop) × risk_to_stop`, all in % of entry,
where P(T1)/P(stop) are the MEASURED per-setup-per-market base rates from
`probability_stats` (the same numbers shown as "P(T1) %" / "P(Stop) %") and
`risk_to_stop = (entry − invalidation) / entry × 100` (also exposed as
`risk_pct`). Computed in `v_scanner_top` / `market_snapshot()` / the
`/top-picks` query — never stored — so it always reflects the current base
rates. `NULL` when there is no probability sample or no valid stop. The
`/top-picks` row adds `similar_expected_value_pct`, the same formula using
that pick's similar-target cohort instead of the whole setup type. It is a
base-rate arithmetic, not a forecast: a 55% hit rate on a +6% target with a
20% stop rate on a 3% stop gives +2.7%, which says how the *class* of past
picks paid, not how this one will.

## Setup classification & confidence (spec section 22/44)

`classifySetupType` picks the single highest sub-score (breakout / momentum
/ pullback / reversal / accumulation) that clears a 55-point minimum;
otherwise `NEUTRAL`. Ineligible stocks (liquidity filter) always classify
`AVOID`, regardless of score. `calculateSetupConfidence` rewards both the
winning score's absolute strength AND its margin over the runner-up — a
breakout scoring 90 with the next-highest sub-score at 30 is a much more
confident call than one scoring 90 with reversal also at 85.

## Risk/reward (`code/riskReward.js`)

Entry/invalidation/targets are ALWAYS derived from real support/resistance
levels or ATR multiples actually present in the data — never an arbitrary
fixed percentage. Targets prefer real resistance levels above entry that
clear the per-market floor `markets.min_target_gain_pct` (EGX 2% / US 1.5%
— a level 0.3% above the close is daily noise, not a target); when fewer
than 3 qualify, later rungs fall back to ATR multiples, and the ladder is
kept strictly ascending (entry < T1 < T2 < T3, honest `null` over an
invented lower rung). Any risk/reward calculation where `risk <= 0`
(invalidation at or above entry) is rejected outright (`null`), never
silently clamped to a fake positive number.

**Per-market ATR stop (`markets.atr_stop_mult`, EGX 2.0 / US 1.5).** The
ATR-based stop used by MOMENTUM / ACCUMULATION / default setups (and as the
BREAKOUT fallback when no support exists) sits `m × ATR14` below entry, and
the ATR target ladder is derived from the same multiple as `(m, m+1, m+2) ×
ATR`, so the fallback Target-1 R:R is exactly 1.0 by construction whatever
`m` is. PULLBACK / REVERSAL stops (support × 0.985, or 1.2 × ATR) are not
affected. Workflow 11 reads the value from `Load Market Config`.

Why 2.0 for EGX and not US: the scoring-lab replay (`scripts/scoring-lab.js`,
run 2026-09-02 over 510 BACKTEST + 87 LIVE-era Top-10 picks for EGX and
440 + 70 for US) compared a dozen candidate variants on gain-aware metrics
(hit / stop-out / expired rates, median gain at T1, mean and median realized
%, expectancy in R, target-free 10-session forward return) and required an
improvement on **both** the backtest slice and the live-era slice before
anything shipped — the 2026-08-24 calibration that was rolled back had won
on hit rate alone. On EGX, `atr_stop_mult = 2.0` cut stop-outs from 16.1% to
10.0% (live slice 26.4% → 15.7%) at an unchanged ~49% hit rate and raised
mean realized gain from +1.59% to +1.98% (live +1.02% → +2.20%). On US the
same change did not help and no other variant was robust on both slices, so
US keeps 1.5. Variants that were **rejected** because they lowered the EGX
hit rate 3–9 points or flipped sign on the live slice: RSI overbought
penalties (>70 / >65), a stronger momentum overextension penalty, blending
the historical probability into the rank (20% / 30%), shifting weight toward
mean-reversion factors, an accumulation boost, and requiring T1 R:R ≥ 1.5.
Any future retune must clear the same two-slice bar.

**Potential gain % and estimated days to target** (`target1_gain_pct` /
`target1_estimated_days` etc., spec: user-requested addition beyond the
original file) are computed alongside each target:

- `gainPct` is plain arithmetic — `(target - entry) / entry * 100` — the size
  of the move IF that target is reached. It says nothing about whether or
  when that happens.
- `estimatedDays` is a rough projection: distance-to-target ÷ (this stock's
  own ATR14 × 0.5). The 0.5 factor is a deliberately conservative,
  **untuned, non-backtested** assumption that a stock nets roughly half its
  average daily true range in directional progress per session (ATR
  measures full high-low range, not net closing movement, and price rarely
  moves in a straight line). It is **not** a historical statistic drawn from
  `prediction_evaluation`, not a forecast, and not a guarantee of when — or
  whether — a target is hit. Every place it's surfaced (API, dashboard) is
  labeled as an estimate/projection for exactly this reason. A
  historically-grounded companion to this estimate exists — see below.

## Historical probability (`16-egx-target-window-evaluation`)

Answers a different question than the estimate above: not "roughly how many
days might this take" but "historically, what fraction of past picks like
this one actually got there?" Two fields, `historical_target1_hit_pct` /
`historical_stop_hit_pct` (API, dashboard: "P(T1) %" / "P(Stop) %"),
surfaced everywhere `target1_gain_pct`/`target1_estimated_days` already are.

**Method**: for every past eligible `scanner_results` row with a valid
`target1`/`invalidation_price`/`target1_estimated_days`, walk forward
day-by-day through real `daily_prices` up to that row's OWN
`target1_estimated_days` sessions, and record whichever happened first:
target1 touched (`TARGET1_HIT`), invalidation touched (`STOP_HIT`), or
neither by the time the window fully elapsed (`EXPIRED_NO_HIT`). A pick
with too little future price history to resolve yet is left unevaluated
and re-checked on `16`'s next run — never guessed early. Same-day
ambiguity (both target1 and invalidation touched on one daily bar — daily
OHLC can't tell us the intraday order) is treated conservatively as a
stop, matching `prediction_evaluation.success`'s existing convention.

**Grouping**: aggregated by `setup_type` only (4-6 buckets), not further
split by score band or estimated-days bucket. This was a deliberate
tradeoff, not an oversight — current sample sizes (a few hundred to a few
thousand per setup type as of this writing) already get thin fast under
finer slicing, and a bucket with single-digit samples would look more
authoritative than it actually is. `historical_sample_size` ships
alongside every probability so the dashboard can flag (and this doc can
warn you) when a number is resting on too little data — treat anything
under roughly 100 samples with real caution, and REVERSAL specifically
(the rarest setup) tends to sit in that range.

**What this is not**: not personalized to the specific stock being viewed
— it's the setup type's track record, not this stock's. Not a guarantee.
Not updated in real time (the pipeline schedules `16` weekly, since the
underlying sample only grows slowly) — check `probability_stats.updated_at`
if you need to know how fresh it is.

## AI Assessment (`17-egx-ai-assessment`)

A third, deliberately distinct signal, alongside the ATR estimate above and
the measured historical rate: a language model's own read of that day's
Top 10 (`overall_rank <= 10`, eligible only — never the full universe, to
keep this cheap). `ai_target1_probability_pct` / `ai_stop_probability_pct`
/ `ai_rank_score` / `ai_rank` / `ai_reasoning` on `scanner_results`,
surfaced as "AI Prob % T1" / "AI Rank" everywhere `target1_gain_pct`
already is, plus a dedicated "AI Assessment" section in the stock detail
drawer. `ai_stop_probability_pct` is the same kind of estimate for the
opposite outcome — the stop/invalidation being hit before Target 1 — and
is not required to sum to 100 with `ai_target1_probability_pct` (price can
do neither within the window).

**Method**: for each Top 10 pick, `17` sends its technical/setup data
(setup type, overall + sub-scores, RSI, MACD, trend classification,
entry/target1/invalidation, gain %, `target1_estimated_days`) — plus that
setup type's own `historical_target1_hit_pct` / `historical_stop_hit_pct` /
sample size, joined from `probability_stats` — to the Anthropic Messages
API (model: `claude-sonnet-5`), with forced tool-use so the response is
always structured JSON rather than parsed prose. The prompt is written as
a calibrated-forecasting exercise: the model is told to treat the
historical hit-rate as its starting anchor (flagged as a weak prior when
the sample is under 20), explicitly reason through the setup-specific
factors that argue for moving above vs. below that anchor, and avoid
defaulting to round numbers or restating the composite `overall_score` as
a probability. It's explicitly told it has no real-time market access, no
news, and only the data given — asked for (1) its own 0-100 probability
estimate for reaching Target 1 within the estimated-days window, (2) a
0-100 conviction score, (3) brief reasoning citing the specific factors
that moved it away from the anchor. `ai_rank` is then derived locally by
sorting that day's picks by conviction score — a second ordering of the
same Top 10, shown alongside `overall_rank`, never replacing it.

**Requires `ANTHROPIC_API_KEY`** (real secret, never committed — see
`env.example.txt`). If unset, invalid, or the API errors for any reason,
`17` doesn't fail — every row it would have touched simply keeps NULL AI
columns, confirmed via live testing (a mocked auth-error response produced
zero writes, not a crash or garbage data).

**What this is not**: not a statistic like `historical_target1_hit_pct`
(that's a measured rate over real past outcomes; this is one model's
qualitative judgment on a single occasion, now grounded in that same
statistic as a starting anchor rather than computed independently of it)
and not a guarantee. Treat disagreement between `ai_rank` and
`overall_rank`, or a large gap between `ai_target1_probability_pct` and
the `historical_target1_hit_pct` it was anchored on, as exactly that —
the model's case-specific adjustment away from the base rate, not a sign
either signal is "right."

## Liquidity filter (spec section 19)

Computed once per stock in `11`, from the trailing 20 `daily_prices` rows:
average traded value ≥ `MIN_AVG_TRADED_VALUE`, average volume ≥
`MIN_AVG_VOLUME`, and at least `MIN_ACTIVE_DAYS_20` non-zero-volume sessions
in that window. Failing any one sets `eligible = false` with a specific
`eligibility_reason` and forces `setup_type = 'AVOID'` — the stock still
appears in `v_full_market` (the full sortable table) but is excluded from
every Top-N list.
