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

**Ichimoku Kinko Hyo** (`code/ichimoku.js`, `ichimoku_*` columns, since
2026-09-06): standard 9/26/52 settings with displacement 26. Stored per bar:
`ichimoku_tenkan` (9-bar midpoint), `ichimoku_kijun` (26-bar midpoint),
`ichimoku_senkou_a` / `ichimoku_senkou_b` (the cloud values IN FORCE at that
bar — i.e. computed 26 bars earlier and plotted forward, so nothing looks
ahead), `ichimoku_cloud_dist_pct` (signed distance from the close to the
nearest cloud edge, % of close: + above, − below, 0 inside) and
`ichimoku_signal` (STRONG_BULLISH / BULLISH / NEUTRAL / BEARISH /
STRONG_BEARISH — price vs cloud decides the side; STRONG additionally needs
the Tenkan on the same side of the Kijun and the close beyond the close 26
bars back, a chikou-span proxy; inside the cloud is NEUTRAL). The cloud needs
52 + 26 = 78 sessions, so a thin history reads NEUTRAL with null spans.
Historical rows were filled by a `backfillAll` replay of `04 - EGX Technical
Analysis` on 2026-09-06 (every stock, both markets). **Context/display only**: it is not an input to
any scanner score, the overall score, ranking, targets or the Top 3 gate, and
it must not become one without passing the two-slice walk-forward rule
(BACKTEST + LIVE, both markets) that every ranking-factor change is held to.

**Price-discontinuity flag** (`code/priceQuality.js`, since 2026-09-06):
`price_discontinuity_count` is the number of close-to-close jumps of ≥3× or
≤⅓ in the trailing 252 sessions; `last_discontinuity_date` /
`last_discontinuity_pct` describe the most recent one. A bad print counts
twice (the jump and the return), an unadjusted split once. It exists because
every rolling indicator, S/R level and score computed across such a bar is
suspect — e.g. SEIGA's EGX history. Deliberately NOT folded into
`data_confidence` or any score: it is a warning the webapp shows next to the
symbol (⚠) and in the detail drawer, so the reader can discount the row.

**Smart Money Concepts** (`code/smartMoney.js`, `smc_*` columns, since
2026-09-06): a deterministic, look-back-only reading of the ICT/SMC
vocabulary on daily bars. Swings are 3-bar fractals confirmed one bar later
(registered at j+1, never earlier). `smc_structure` is BULLISH after a close
above the last unbroken swing high / BEARISH after a close below the last
unbroken swing low; `smc_last_event` is BOS when that break continued the
prevailing structure and CHOCH when it reversed it, with
`smc_event_bars_ago`. An order block is the last opposite-colour candle in
the 20 bars before the break (`smc_bull_ob_*` / `smc_bear_ob_*`), dropped
once a close passes through it. Fair value gaps are 3-candle imbalances
(`smc_fvg_bull_*` / `smc_fvg_bear_*` = the nearest still-unfilled one, max
age 250 bars). `smc_sweep` (BULLISH/BEARISH, `smc_sweep_bars_ago`, memory
20 bars) marks a wick through a swing that closed back inside — the classic
liquidity grab. `smc_range_pos_pct` is the close between the last swing low
(0) and swing high (100); `smc_bias` combines structure with that position:
BULLISH_DISCOUNT / BULLISH_PREMIUM / BEARISH_PREMIUM / BEARISH_DISCOUNT
(≤50 = discount). All of it is **context/display only** — the same rule as
Ichimoku: not a score, rank, target or Top 3 input, and it must earn its way
in through the two-slice walk-forward test before it ever becomes one.
Historical rows (and the discontinuity columns) were populated by the same
2026-09-06 `backfillAll` replay: 237/237 EGX and 503/503 US stocks.

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
answers the separate question "is TODAY a good day to get in?". Computed in
workflow 11's scoring node alongside the overall score, stored per pick
(`entry_quality_score` plus the raw inputs `extension_atr`,
`close_position_pct`, `rsi_slope3`) and shown after Score and EV net on
`/top`, `/top-picks`, `/stocks` and in the dashboard. **Display-only**: not
a ranking factor (see the lab verdicts below).

**v2 (2026-09-14) — empirical.** Points come from the measured EGX record
(13,404 evaluated Top-10 picks 2021–2026), derived on 2021–2024 and checked
out of sample on 2025–2026:

- **Extension vs trend (30 pts)** — `(close − EMA20) / ATR14`: <0 → 0 ·
  0–1 → 8 · 1–2 → 14 · 2–3 → 18 · 3–4 → 25 · 4+ → 30. Target-1 hit rate by
  bucket was 24 / 31 / 34 / 35 / 40 / 49% — extended names hit MORE often,
  the opposite of v1's assumption.
- **Relative volume 20d (20 pts)** — <1 → 0 · 1–2.5 → 10 · 2.5+ → 20.
- **RSI 3-session slope (20 pts)** — <−5 → 0 · −5..5 → 6 · 5..10 → 13 ·
  >10 → 20.
- **Close position in range (15 pts)** — `(close − low) / (high − low)` × 15.
- **SMC zone (15 pts)** — DISCOUNT 0 · PREMIUM 15 · unknown 8 (discount
  entries hit 25.5% vs 35.8%, and it holds inside extension × RVOL buckets).

Out of sample (2025–26): 85+ scored 48.7% hit / +3.01% realized per pick;
the middle buckets 31–36%. **US**: only relative volume carried a signal
(15.7% hit below 1×, 27.5% at 1–2.5×, 33.3% at 2.5×+; the other four
components were flat or inverted), so the US score is relative volume alone
(15 / 50 / 85). A missing input sits at its midpoint, so a stock with no
EMA yet is "unknown", not "bad". Rows scored before 2026-09-14 hold v1
values unless backfilled (BACKTEST rows were; LIVE rows are only rewritten
with the user's OK).

**v1 (2026-09-02 → 2026-09-14) and why it was replaced.** v1 gave 40 pts
for sitting −0.5..+1 ATR above the EMA20 (fading to 0 at +3 ATR), 30 for
close position and 30 for RSI slope. Bucketed on the full record its top
band (85+) was the WORST band by realized return (+0.93%/pick vs +1.61%
mid) — a hump, not a ladder — because the extension term punished exactly
the entries that worked. Its components were re-measured one by one and
only those with a monotonic, out-of-sample lift were kept (v2 above).

**Ranking blend — still rejected.** Lab 2026-09-02 (v1, variants
`V13`/`V14`/`V15`): 10% blend took EGX BACKTEST hit 48.2 → 47.6% and LIVE
50.0 → 46.3%, live stop rate 15.9 → 18.3%, mean realized +2.19 → +1.39%;
20% worse; US LIVE hit 26.5 → 23.5% / 19.1% — fails the two-slice rule.
Whether the v2 score should influence ranking is a separate lab run and
has not been done; until it passes both slices it stays a displayed
number.

## Validated context flags (2026-09-18)

Output of the swap-engine confluence lab (docs/SWAP-ENGINE-PLAN.md phases
0–3; `sql/lab/features.sql`, `scripts/confluence-lab.js`). 97 binary
features and their complements, all pairs and triples, tested on EGX Top-10
picks 2021–2024, replicated on 2025–26 and checked against LIVE, always
against the pick's own extension × RVOL × market-score cell. Everything the
scanner already looks at (RSI, MACD, EMAs, SMC alone, Ichimoku alone,
candlesticks alone) was absorbed by that cell. Two things were not:

- **Breakout close** (`breakout_close` = `50D_HIGH` / `20D_HIGH`): the
  scan-day close is at or above its 50-day (or 20-day) high. EGX Top-10:
  52% hit vs 34%, +3.3% vs +0.5% realized per pick (mark-to-market);
  positive in every single year 2021–2026 including the 2022/2024 loss
  years, in liquid and thin names alike, LIVE 70% hit (n=23). Ichimoku adds
  value only on top of it (cloud distance ≥ 20%: 57% hit vs 46%).
- **Caution** (`caution_flag`): annual volatility in the market's top
  quartile (`markets.volatility_caution_pct`, EGX 59.6 / US 41.3) while not
  ≥ 10% above the Ichimoku cloud. Negative realized (mark-to-market) return
  in 5 of 6 years — but its HIT RATE is flat (EGX 35.0% vs 35.3%, n=1,265;
  US 31.8% vs 26.4%, n=223): the damage is in how expired trades drift, not
  in reaching the target. It is therefore NOT shown as a badge (a "caution"
  next to a normal hit rate would mislead); the columns stay on the API for
  the swap comparator, which works in realized return.

Both are stored as extra levels of `probability_context_stats` (level `H`,
`flag_bucket` h50/h20/h0; level `V`, v1/v0), refreshed by workflow 16 with
the grid, read by `flag_rate()` and exposed on `v_scanner_top` with their
own measured hit/stop rate and sample size. **They are deliberately NOT
folded into `context_probability()` / EV**: adding the breakout dimension
to the grid moved walk-forward Brier by 0.0004 on holdout and slightly
worsened LIVE (a 5–10% cell cannot move an aggregate score), while the
variant that helped on both slices did so by dropping market score — a
restructure not justified until market score gets the same per-year audit.
Decision 2026-09-18 (user): additive flags now, grid audit later. The
dashboard shows the breakout close as one "Signals" column next to EV net.

US: no positive cell replicated; only avoid-states (near resistance while
the index is up; non-momentum/accumulation setups). US ranking remains
indistinguishable from random.

## Pick order (2026-09-18, phase 4)

The order a non-expert should take the day's picks in, measured on every
evaluated EGX pick 2021→today (train / holdout 2025–26 / live):

| Tier | Rule | Hit rate | Picks/day |
|---|---|---|---|
| 1 Breakout close | Top 10, close at its 20/50-day high, not caution | 52% / 50% / 70% | ~1.5 |
| 2 Volume + extended | Top 10, RVOL ≥ 2.5× and extension ≥ 3 ATR | 45% / 47% / 46% | ~2.5 |
| 3 Standard | rest of the Top 10 in score order | 34% / 38% / 44% | ~6 |
| 4 Caution | top-quartile volatility, not ≥ 10% above the cloud | 30% hit, −1.2%/pick | ~0.4 |

`pick_tier()` (sql/003-views.sql) computes the tier from the same inputs
workflow 16 counts with; level `T` of `probability_context_stats` stores each
tier's measured hit/stop rate, exposed as `tier_hit_pct` / `tier_stop_pct` /
`tier_n` next to `pick_tier` / `pick_tier_label` on `v_scanner_top`. `/top`
returns rows ORDER BY pick_tier, overall_rank with `accuracy_rank` = that
position; `/top-picks` applies the same order before its structural gate.
US: nothing replicated, so every US pick is tier 3 and the order is
unchanged. The Score and overall_rank are untouched — this is an ORDER laid
over the ranking, not a change to it. Ten-slot simulation, 1M EGP, per-year
restart: plain Top 10 3.30M → breakout-first 5.70M → breakout-first + skip
caution 6.08M (index 4.96M); 2021–2024 in-sample for the tier-1 rule,
2025–26 out of sample (+79% vs +53%, +52% vs +43%).

### Swap advisor (phase 4b, 2026-09-19)

My Slots shows two kinds of suggested action, both advisory, EGX only:

- **Exit** an open caution (tier 4) position after its first session. Measured
  remaining return of open caution positions (2025–26): −2.5% after day 1,
  −4.1% after day 2, −6.2% after day 3 (n = 75 / 51 / 37).
- **Swap** an open standard (tier 3) position for an unplaced tier-1 pick when
  no slot is free. Basis: a new tier-1 pick returns +2.76% over its window
  (n = 387); an open tier 1–3 position returns only +0.1..+1.0% over the rest
  of its window (we use +0.5); two round trips cost 0.8%. Edge ≈ +1.5%. In
  the six-year portfolio simulation the rule fired 52 times: the replaced
  positions were sold at +0.16% (they would have finished at −0.14%) and the
  tier-1 picks earned +1.87%. Roughly nine events a year, so about +2% a year
  for a ten-slot portfolio — real but modest. The much larger compounded
  differences the simulation shows between swap and no-swap variants are
  path effects (a swap changes every later slot assignment), not the swap
  edge, and are not quoted. Nothing is executed automatically.

## Exit rule C: stop to breakeven at half-way (phase 5, 2026-09-19)

Seven exit rules were measured on the same 13,403 EGX and 2,620 US evaluated
Top-10 picks (expired trades marked at the last window close, cost
subtracted). Every rule that shortens the target (half TP1, 75% TP1,
scale-outs, half stop) lost money against the fixed stop. The one rule that
beat it on BOTH EGX slices: keep the full Target 1, move the stop to the
entry once a session's high reaches half the distance to Target 1 (armed
from the next session). Net per pick +0.31 vs +0.28 (backtest), +0.38 vs
+0.08 (live); losing trades 36% vs 46%; per slot-day 0.101 vs 0.086 (BT),
0.196 vs 0.042 (live). US: equal on backtest, least bad on live.

Stored as a PARALLEL label, `target_window_evaluation.outcome_be`
(TARGET1_HIT / BREAKEVEN_EXIT / STOP_HIT / EXPIRED_NO_HIT) with
`resolved_day_number_be`, computed by workflow 16 next to the fixed-stop
`outcome`, which stays the truth for every hit-rate statistic. Level `X` /
`c` of `probability_context_stats` holds the rule-C counts per market;
`exit_rule_c_rate()` reads them; `v_scanner_top` exposes
`breakeven_trigger` (= entry + 0.5 × (T1 − entry)) and `be_rule_*`. Trade
Ideas shows "Move stop to entry at" with the measured rates in the tooltip.
Advisory — the scanner's own targets and stops are unchanged.

## Expected value (`expected_value_pct`)

`EV = P(T1) × gain_to_T1 − P(stop) × risk_to_stop`, all in % of entry,
where P(T1)/P(stop) are MEASURED base rates and
`risk_to_stop = (entry − invalidation) / entry × 100` (also exposed as
`risk_pct`). Since 2026-09-08 `v_scanner_top` (the `/top` and `/top-picks`
rows) takes P(T1)/P(stop) from the **conditional context rate**
(`context_target1_hit_pct` / `context_stop_hit_pct`, see "Conditional base
rates" below) and falls back to the per-setup-per-market
`probability_stats` rate only when the market has no context row yet;
`probability_source` on each row says which one was used.
`market_snapshot()` (the full-market table) still uses the per-setup rate.
Since 2026-09-11 `v_scanner_top` also carries `expected_value_net_pct` =
EV minus `markets.round_trip_cost_pct` (EGX 0.40%, US 0.05%; commissions,
fees and stamp duty for both legs — adjust to your broker), shown as
"EV net %" on the Top-10 and Top-3 tables. Display only.
Computed in the views — never stored — so it always reflects the current
base rates. `NULL` when there is no probability sample or no valid stop. The
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

**BREAKOUT is scored but not ranked (since 2026-09-04).** Workflow 11's
`Assign Overall Rank` gives `overall_rank` only to rows that are eligible
AND not `BREAKOUT`; BREAKOUT rows keep their scores, targets, `setup_type`
and a NULL rank (sorted after the ranked rows on `/top`, `/stocks` and the
dashboard, exactly like ineligible rows), and `16` still evaluates them so
their base rate in `probability_stats` keeps updating. Evidence: the
full-history scoring lab of 2026-09-04 (`scripts/scoring-lab.js` replayed
through n8n over EGX 2025-11-12 → 2026-09-03 and US 2025-08-04 → 2026-09-02,
BACKTEST + LIVE, ~51k Top-10 picks across 11 variants) found BREAKOUT to be
the only setup with negative expectancy in all four market × slice
cells — EGX BACKTEST n=216 hit 30.1% / stop 27.3% / −0.008 R, US BACKTEST
n=552 hit 20.5% / stop 33.7% / −0.126 R, and both LIVE slices worse (US LIVE
stop rate 70% on n=10) — while ACCUMULATION and MOMENTUM were positive in
all four. The structural reason is in `buildTradeStructure`: a BREAKOUT
entry sits just above resistance-1 while its stop sits at support-1, so
the risk is the whole prior range and the entry only fills after the move
has started. Removing it from the rankable set (`V8_noBreakout`) raised the
Top-10 hit rate EGX BACKTEST 38.9 → 40.1% / LIVE 50.0 → 52.6% (mean realized
+1.01 → +1.14% / +1.72 → +2.43%) and US BACKTEST 27.1 → 28.2% (+0.10 →
+0.20%); US LIVE (n≈88) was neutral (stop rate 26.4 → 20.2%, mean realized
−0.23 → −0.20%, hit 26.4 → 23.6% ≈ 2 picks). Month by month it helped in
10/11 EGX months and 9/14 US months on hit rate, 10/11 and 12/14 on mean
realized — not a single-regime effect. Lab `V0_default` now mirrors this;
`V8_allowBreakout` is the variant that re-admits BREAKOUT for future checks.
The same lab **rejected** `minRR 1.0` (raises target size, lowers hit rate
6–15 pt), `rsVsIndex` weighting (±0.5 pt, sign flips on US LIVE), a
market-score regime gate (no monotonic band edge on either market) and
`stop 1.5` on EGX / `stop 2.0` on US (confirming the per-market multiples
below).

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

**Per-market ATR stop (`markets.atr_stop_mult`, EGX 2.5 since 2026-09-11 (2.0
from 2026-09-02) / US 1.5).** The
ATR-based stop used by MOMENTUM / ACCUMULATION / default setups (and as the
BREAKOUT fallback when no support exists) sits `m × ATR14` below entry, and
the ATR target ladder is derived from the same multiple as `(m, m+1, m+2) ×
ATR`, so the fallback Target-1 R:R is exactly 1.0 by construction whatever
`m` is. PULLBACK / REVERSAL stops (support × 0.985, or 1.2 × ATR) are not
affected. Workflow 11 reads the value from `Load Market Config`.

Why 2.5 for EGX (2026-09-11): see "EGX lab batch 2026-09-11" below — the
full-history ladder 1.5 / 1.75 / 2.0 / 2.25 / 2.5 / 3.0 / 3.5 improves
realized return per pick monotonically on BACKTEST, but LIVE plateaus at 2.5
and risk per position passes 15% beyond it. Why 2.0 was chosen first, and
not US: the scoring-lab replay (`scripts/scoring-lab.js`,
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

**Gap-through flag** (`gapped_through` / `resolved_open` / `gap_pct`, added
2026-09-06): a daily bar only says a level was touched, not whether the
session *opened* already beyond it. `16` now records that too — TRUE when
the resolving session's open was at/above target1 (TARGET1_HIT) or at/below
the invalidation (STOP_HIT), FALSE when the level was crossed intraday, NULL
for EXPIRED_NO_HIT. `gap_pct` is `(open − level) / level × 100`: positive
on a target gap (the fill was better than the target), negative on a stop
gap (the loss was worse than the planned risk — the stop could not be
honoured). It is deliberately a flag, not a fourth outcome: a gapped
target is still a hit and a gapped stop is still a stop, so every hit rate
above stays comparable across the whole history. The dashboard marks
gapped rows with ⚡ and the Track Record shows gapped counts, the gapped
stop rate and the average stop gap per scope/setup. Rows evaluated before
this date were backfilled from `daily_prices` in one pass.

## Conditional base rates (`probability_context_stats`, since 2026-09-08)

The per-setup rate above turned out to carry no information beyond the
market-wide rate. Walk-forward over every evaluated Top-10 pick (each
pick's estimate uses only picks dated ≥ 15 days earlier, so no outcome
leaks in), scored by Brier (lower is better):

| model | EGX BACKTEST n=1.6k | EGX LIVE n=100 | US BACKTEST n=2.5k | US LIVE n=72 |
|---|---|---|---|---|
| market-wide rate | 0.2395 | 0.2697 | 0.1979 | 0.2006 |
| per-setup rate (`probability_stats`) | 0.2395 | 0.2712 | 0.1971 | 0.2017 |
| market_score band only | 0.2411 | 0.2690 | 0.1980 | 0.1980 |
| extension × RVOL | 0.2353 | 0.2575 | 0.1969 | 0.1963 |
| **extension × RVOL × market_score** | **0.2354** | **0.2507** | 0.1975 | 0.1976 |
| setup × extension × RVOL × market_score | 0.2374 | 0.2464 | 0.1972 | 0.1948 |
| AI assessment (LLM, where present) | — | 0.2582 (n=88) | — | 0.2151 (n=48) |

Reliability of the shipped model in EGX is monotonic in both slices
(BACKTEST predicted 25 → hit 32%, 35 → 38, 44 → 45, 53 → 55; LIVE 27 → 36,
37 → 47, 42 → 58, 54 → 59, 63 → 83) where the per-setup rate is not (its
40–50% bucket hit 29.6% on 135 BACKTEST picks). The AI number is flat
(36 → 50, 45 → 48, 52 → 51). On US every model is within ±0.001 of the
others — a wash, so one code path serves both markets.

**Method.** `16` refreshes `probability_context_stats` next to
`probability_stats`: outcome counts of evaluated Top-10 eligible picks
(LIVE + BACKTEST, gain ≥ `min_target_gain_pct`) per market at three
levels — `ALL` (market only), `ER` (extension bucket × relative-volume
bucket) and `ERM` (× market-score band). Buckets come from
`prob_context_buckets()` (extension = (entry − EMA20) / ATR14: <1, 1–2,
2–3, 3–4, ≥4; RVOL20: <1, 1–1.5, 1.5–2.5, ≥2.5; `market_score`: <40,
40–60, ≥60) so counting and lookup can never disagree.
`context_probability(market, ext, rvol, ms)` returns the `ERM` cell rate
shrunk toward its parents with k = 20 pseudo-picks at each level —
`p_er = (hits_er + 20·p_all) / (n_er + 20)`, `p_erm = (hits_erm + 20·p_er)
/ (n_erm + 20)` — so an empty cell returns its parent and a 200-pick cell
is ~90% its own rate. Exposed on `v_scanner_top` as
`context_target1_hit_pct`, `context_stop_hit_pct`, `context_sample_size`
(the exact cell), `context_parent_sample_size` (the extension × volume
cell) and `context_cell` (a label), and given to `17` as the AI's primary
anchor. Not a ranking input: scoring and gates are unchanged.

**Why these three inputs.** The 2026-09-07 bucket cut and its robustness
checks (episode dedup, chronological terciles, market-score bands, same-run
pairing, strata by momentum / gain / est. days / setup) found that in EGX
extension does not hurt once relative volume is high (ext ≥ 3 ATR × RVOL ≥
2.5: 55% hit / +2.7% BACKTEST, ~63% LIVE) but the edge vanishes in weak
regimes (Feb–May 2026, market_score < 40), and that US shows nothing.
A hand-built penalty or bonus was rejected; this table lets the measured
rates carry that information instead.

## EGX lab batch 2026-09-11 (stop placement, regime, targets, over-extension)

Full EGX history (2025-11-12 → 2026-09-10, 202 scan days, BACKTEST 1,811
Top-10 picks + LIVE 147), replayed by `scripts/scoring-lab.js` through the
ZZ Scoring Lab v3 helper (per-pick rows in the scratch table `lab_picks`).
Realized = +gain on a hit, −risk on a stop, window-close return on expiry.
Per-day figures count skipped days as 0 so a regime gate is charged for the
days it sits out.

| variant | BT hit / stop | BT realized per pick | BT per day (all days) | LIVE hit / stop | LIVE realized per pick |
|---|---|---|---|---|---|
| V0 production (stop 2.0 ATR) | 40.1 / 12.8 | +1.14 | +1.14 | 44.2 / 13.6 | +1.26 |
| stop 1.5 ATR | 41.3 / 19.7 | +0.92 | +0.92 | 43.8 / 26.8 | +0.32 |
| stop 1.75 ATR | 42.5 / 16.3 | +1.15 | +1.15 | 46.3 / 19.7 | +1.13 |
| **stop 2.5 ATR** | 38.8 / 7.8 | **+1.35** | +1.34 | 45.8 / 7.7 | **+2.03** |
| risk cap 6% | 36.4 / 19.5 | +0.74 | +0.74 | 41.1 / 15.6 | +0.95 |
| risk cap 8% | 37.3 / 14.8 | +0.81 | +0.81 | 41.0 / 11.1 | +1.30 |
| target cap 12% | 41.2 / 12.3 | +1.09 | +1.09 | 46.9 / 14.3 | +1.41 |
| target cap 15% | 40.7 / 12.6 | +1.13 | +1.13 | 44.9 / 14.3 | +1.25 |
| regime gate: skip day if market_score < 40 | 40.4 / 12.8 | +1.11 | +1.03 | (no LIVE day < 40) | +1.26 |
| regime gate: skip if < 50 | 39.8 / 12.5 | +1.08 | +0.85 | 45.3 / 14.6 | +1.16 |
| half size when < 40 | 40.1 / 12.8 | +1.09 | +1.09 | 44.2 / 13.6 | +1.26 |
| **no over-extension penalty** | 40.9 / 13.0 | **+1.25** | +1.25 | 46.6 / 14.4 | **+1.60** |
| **stop 2.5 + no penalty** | 39.7 / 7.9 | **+1.48** | +1.47 | 48.2 / 7.1 | **+2.42** |

Verdicts (two-slice rule: must improve realized return in BACKTEST **and**
LIVE):

- **Stops: tighter is worse, wider is better, in both slices.** 1.5 ATR
  (the pre-2026-09-02 value) loses a quarter of the edge and doubles the
  stop rate; 2.5 ATR halves the stop rate (12.8 → 7.8%) and lifts realized
  return per pick by 18% on the history and 60% live. Note `atr_stop_mult`
  also moves the ATR target ladder (m, m+1, m+2), so median target distance
  rises from 6.1% to 6.8%. Average risk to the stop rises from 7.8% to 9.7%.
  The expected loss per pick (stop rate × risk) still falls, 1.00 → 0.76.
- **Risk caps are rejected.** Refusing picks whose stop is more than 6% or
  8% away removes the very picks that pay (−0.33 to −0.40 per pick on the
  history). The 2026-09-10 control had suggested the opposite from the
  LIVE Top-10 vs ranks 11–20 gap; on the full history that gap is noise.
- **Target caps are neutral to slightly negative.** Not shipped.
- **Regime gates are rejected in every form.** Skipping days below a market
  score of 40 or 50, or halving size, loses money on the history: the
  skipped days were on average *better* than the rest (+1.65% per day for
  the 12 days under 40). The 2026-09-02 stored-data cut that motivated the
  gate was computed on rows that predate the current scoring. The
  extension × RVOL cell edge is still regime-dependent, but that is what
  the context base rates already encode; a hard gate is not the tool.
- **Removing the >2.5-ATR over-extension penalty from the momentum score
  wins in both slices** (+0.11 / +0.34 per pick) and improves the
  target-free 10-session return too (3.07 → 3.71% BT). Shipped for EGX via
  `markets.momentum_overext_penalty = FALSE` (workflow 08 reads it in Load
  Active Stocks; the warning text is still emitted). US keeps the penalty —
  it was not tested there.
- **The combination (stop 2.5 + no penalty) is the best variant in both
  slices** and roughly additive.

**Stop ladder (batch 2, same history), realized % per pick BACKTEST / LIVE,
with the over-extension penalty on and off; avg risk to the stop in % of
entry (BT / LIVE):**

| ATR multiple | penalty on | penalty off | avg risk | BT hit / stop rate |
|---|---|---|---|---|
| 2.0 (was production) | 1.14 / 1.26 | 1.25 / 1.60 | 7.8 / 10.2 | 40.1 / 12.8 |
| 2.25 | 1.29 / 1.58 | 1.42 / 1.91 | 8.8 / 11.5 | 40.4 / 10.3 |
| **2.5 (shipped)** | 1.35 / 2.03 | **1.48 / 2.42** | 9.7 / 12.8 | 38.8 / 7.8 |
| 3.0 | 1.42 / 1.81 | 1.66 / 2.40 | 11.7 / 15.4 | 36.5 / 5.5 |
| 3.5 | — | 1.81 / 2.35 | 13.7 / 18.1 | 35.7 / 4.3 |

BACKTEST keeps improving with a wider stop all the way to 3.5, but LIVE
plateaus at 2.5 and every step beyond it adds 2–3 points of risk per
position and a worse worst-case pick (−18% at 2.5, −22% at 3.0, −27% at
3.5). 2.5 is the widest value that improves both slices over its lower
neighbour, so `markets.atr_stop_mult` for EGX is 2.5 from 2026-09-11.
Holds lengthen slightly (average estimated window 4.0 → 4.4 sessions) and
the median Target 1 rises from 6.1% to 6.8%, because the multiple also sets
the ATR target ladder.

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

## Top 3 Trade Ideas (`/top-picks`, since 2026-09-04)

The eligible Top 10 of the day — never a lower rank — kept only where the
Target 1 is structurally within reach, then the first 3 by `overall_rank`.
Two gates, both must pass, both from `scanner_results` columns the reader
already sees:

1. `setup_type IN ('ACCUMULATION', 'MOMENTUM')` — PULLBACK and REVERSAL
   Top-10 picks had negative expectancy in both markets; BREAKOUT is no
   longer ranked at all (above);
2. `target1_estimated_days <= 5 AND risk_reward_t1 < 1.5` (NULL fails) —
   a Target 1 more than ~5 ATR-sessions away is rarely reached inside its
   own window (est. days > 5: EGX 15.9% hit vs 42.0%; US 10.5% / 0% vs
   29.9% / 26.6%, BACKTEST / LIVE), and an R:R ≥ 1.5 here means a stop
   that is tiny next to the target (20–50% stop-outs in every slice).

Full-history scoring lab 2026-09-04 (51k replayed Top-10 picks, both
markets, BACKTEST and LIVE), Top-3-by-rank of the gated set vs the ungated
Top 3:

| slice | gated: hit / mean realized / expectancy | ungated Top 3 |
|---|---|---|
| EGX BACKTEST n=545 | 44.0% / +1.01% / +0.126R | 41.2% / +0.96% / +0.125R |
| EGX LIVE n=33 | 51.5% / +2.33% / +0.169R | 50.0% / +2.13% / +0.165R |
| US BACKTEST n=783 | 31.7% / +0.27% / +0.043R | 30.3% / +0.24% / +0.039R |
| US LIVE n=32 | 46.9% / +1.65% / +0.292R | 34.4% / +0.20% / +0.020R |

Better on all three measures in all four slices, with picks on every day;
the BACKTEST differences are small, the LIVE ones rest on ~11 days each.
Not a "closer target" effect: `markets.min_target_gain_pct` still applies
and mean realized rises with the hit rate.

Three gates that were in `/top-picks` before were removed on the same
data, each for its own reason:

- the **≥ 5% gain to Target 1** floor lowers the EGX hit rate to 37–42%
  (bigger targets) while raising mean realized — a product trade-off, but
  "accuracy" is the stated goal and the trivially-close-target loophole is
  already closed by `min_target_gain_pct`;
- the **similar-size cohort ≥ 50% hit on ≥ 20 picks** gate: walk-forward
  over 10 months it passed 1 EGX BACKTEST pick, and at any threshold
  (40/45/50, base+5, EV > 0, cohort mean ≥ 1%) the picks it kept did no
  better than the ones it dropped — the 2026-09-02 US result was a
  regime artefact;
- the **AI P(Target 1) ≥ 40%** gate was never validated (EGX LIVE
  evaluated rows: P<40 55.6% hit on 9, 40–49 44.0% on 25, ≥50 60.4% on
  48; US has 13 scored rows) and blanked the US table on days the model
  scored every pick in the 30s. Re-test once ~200 evaluated rows per
  market carry an AI score.

The `similar_*` cohort rates and the AI columns are still returned on each
row as measured / model context, not as filters. A day with nothing that
clears the bar returns fewer than 3 rows, down to zero — accuracy over
filling slots.

Since 2026-09-11 this tab is the dashboard's default view. A capital-
recycling simulation on the EGX history (10 slots of 100k each, every slot
redeployed into the best-ranked unheld pick the day it frees, 2025-11-12 →
2026-09-09, stored outcomes, fills at the levels) gives, after a 0.4%
round-trip cost: Top-10 slots +59.6% (729 trades, max drawdown 12.8%),
Trade Ideas slots +93.5% (787 trades, drawdown 10.1%), Trade Ideas with 3
slots +126.5% (246 trades, drawdown 16.5%). The single-pot "wait for the
slowest pick" model that was compared against EGX30 earlier gave +31%
because the pot idled more than half the time; redeploying per slot is
what closes the gap to buy-and-hold (+40% over the same dates) and beyond.
An execution rule, not a scoring change, and the usual caveats apply
(no slippage, best regime in the data inside the window).

The dashboard's **My Slots** panel (2026-09-11) is the tool for that rule:
"+ slot" on a Top 10 / Top 3 row records the pick with its published entry,
Target 1, stop and window; "Check status" reads the pick's scan-date row
from `/top` (actual window high/low, sessions elapsed, evaluated outcome)
and reports Target hit / Stop hit / Window ended / Open; the free-slot count
lists the top-ranked picks on the current table that are not already held.
State lives in the browser's localStorage only (per device, per viewer).

## Liquidity filter (spec section 19)

Computed once per stock in `11`, from the trailing 20 `daily_prices` rows:
average traded value ≥ `MIN_AVG_TRADED_VALUE`, average volume ≥
`MIN_AVG_VOLUME`, and at least `MIN_ACTIVE_DAYS_20` non-zero-volume sessions
in that window. Failing any one sets `eligible = false` with a specific
`eligibility_reason` and forces `setup_type = 'AVOID'` — the stock still
appears in `v_full_market` (the full sortable table) but is excluded from
every Top-N list.
