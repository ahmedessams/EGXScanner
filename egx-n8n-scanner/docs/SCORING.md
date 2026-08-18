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
and EMA50 rising (30pt) — proximity to EMA20/support (30pt), RSI cooled into
40-55 (20pt), declining sell-side volume on down days (15pt). A negative
daily return is logged as context, never a penalty.

**Reversal** (`reversalScore.js`): oversold RSI (25pt), support proximity
(20pt), volume spike (20pt, read as possible capitulation rather than
confirmation), bullish candle structure (10pt), MACD improving (15pt),
positive RSI divergence (10pt) — **left `false`/unused in v1**, because
robust divergence detection needs more history-aware peak/trough matching
than is worth the false-positive risk here; treat it as a documented gap,
not a hidden claim.

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
- **relative_strength** — 20-day return scaled around 50, a simple
  vs-flat proxy (not vs-market — the query doesn't carry a market-wide
  return series to this step; see `marketRegime.js`'s `averageDailyReturn`
  in the daily report if you want an actual market comparison).
- **risk_reward** — `riskRewardT1` scaled, 0 if no valid R:R exists.

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
fixed percentage. Targets prefer real resistance levels above entry; when
fewer than 3 exist, later targets fall back to ATR multiples (1.5×/2.5×/3.5×
from entry). Any risk/reward calculation where `risk <= 0` (invalidation at
or above entry) is rejected outright (`null`), never silently clamped to a
fake positive number.

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

## Liquidity filter (spec section 19)

Computed once per stock in `11`, from the trailing 20 `daily_prices` rows:
average traded value ≥ `MIN_AVG_TRADED_VALUE`, average volume ≥
`MIN_AVG_VOLUME`, and at least `MIN_ACTIVE_DAYS_20` non-zero-volume sessions
in that window. Failing any one sets `eligible = false` with a specific
`eligibility_reason` and forces `setup_type = 'AVOID'` — the stock still
appears in `v_full_market` (the full sortable table) but is excluded from
every Top-N list.
