# Feature inventory (Phase 0 of docs/SWAP-ENGINE-PLAN.md) — 2026-09-18

Coverage = share of Top-30 picks (BACKTEST + LIVE, both markets, scans since
2025-06-01) with a non-NULL value. Measured live via information_schema +
jsonb_each_text over the joined rows.

## Stored per stock per scan date

### technical_analysis (written by wf04) — 100% unless noted
| Family | Columns | Coverage |
|---|---|---|
| Moving averages | sma20/50/100/200, ema9/20/50/100/200 | 100% (sma/ema200 98.4%) |
| Oscillators | rsi14, macd, macd_signal, macd_histogram | 100% |
| Volatility | atr14, volatility_annual_pct, drift_annual_pct | 100% / 99.9% |
| Volume | obv, volume_sma20/50, relative_volume20/50 | 100% |
| Rate of change | roc5, roc10, roc20 | 100% |
| Ranges | high20/50/252, low20/50/252, distance_52w_high/low | 100% (252: 97.7%) |
| Trend labels | short_/medium_/long_term_trend, long_term_score | 100% / 98.4% |
| Drift estimates | est_2w/1m/3m/1y_pct (display-only) | 99.9% |
| Ichimoku | tenkan, kijun, senkou_a, senkou_b, cloud_dist_pct, signal | 99.4–99.7% |
| Price quality | price_discontinuity_count, last_discontinuity_date/pct | 99.7% / 1.8% (rare by design) |
| SMC | smc_structure, smc_last_event, smc_event_bars_ago | 99.7% |
| SMC zones | smc_bull_ob_low/high 90.8% · smc_bear_ob_low/high **9.3%** · smc_fvg_bull_low/high 98.7% · smc_fvg_bear_low/high **36.6%** | |
| SMC liquidity | smc_sweep, smc_sweep_bars_ago 65.9% · smc_range_pos_pct, smc_bias 97.8% | |

### support_resistance (wf05)
support1/2/3 + strength 99.8 / 98.2 / 92.2% · resistance1/2/3 + strength
**76.3 / 47.9 / 28.1%** (a Top-30 pick is often at or near its highs, so
no resistance above is common and is itself a feature) ·
nearest_support_distance_pct 99.8% · nearest_resistance_distance_pct 76.3%.

### volume_analysis (wf06) — 98.7%
volume_change_1d_pct, volume_change_vs_20d/50d_pct, volume_rank,
traded_value_rank, relative_volume20/50_rank, accumulation_score.

### scanner_results (wf07–11) — 100% unless noted
Sub-scores (breakout, momentum, pullback, reversal, accumulation, volume,
trend, risk_reward), overall_score, overall_rank, setup_type,
setup_confidence, data_confidence, eligible; trade structure entry /
invalidation / target1–3 (+ gain %, est days, R:R) 99.8 / 98.7 / 91.6%;
relative_strength_20d, entry_quality_score (v2), extension_atr,
close_position_pct 96.4%, rsi_slope3 90.9%; AI columns **2.2%** (LIVE Top-10
only — never a backtest feature).

### scanner_runs (per run)
market_score, market_regime, stocks_scanned, eligible_stocks — regime and
breadth proxies, 100% of runs.

### Outcomes (labels, never features)
target_window_evaluation: outcome, resolved_day_number, gapped_through,
resolved_open, gap_pct, mfe/mae 1/3/5/10d, ret_5d/10d;
prediction_evaluation: next_open/high/low/close, MFE/MAE next day, target
hits. daily_prices supplies mark-to-market closes and forward candles.

## Not stored, computable from daily_prices at lab time
Candlestick flags (engulfing, hammer, marubozu, inside bar, consecutive
strong closes), gap-up vs previous high, range expansion vs ATR, range
compression (10d/30d range ratio as a Bollinger/Keltner-squeeze proxy),
previous-week / previous-month high proximity, Donchian position, MFI/CMF,
average traded value 20d (liquidity tier), index 20d return and index vs
its 50d SMA. All cheap window functions; none require a pipeline change
until proven.

## No data source (out of scope)
Bid/ask, delta, footprint, intraday and multi-timeframe structure, news,
sentiment, analyst revisions, fundamentals beyond dividends, sector
classification (stocks.sector is mostly empty for EGX).

## Categorical vocabularies (Top-30 picks since 2024, n = 28,157: EGX 19,628 / US 8,529)
| Column | Values (count) |
|---|---|
| setup_type | MOMENTUM 16,495 · ACCUMULATION 4,880 · PULLBACK 3,040 · NEUTRAL 2,266 · BREAKOUT 1,356 · REVERSAL 97 · AVOID 23 |
| medium_term_trend | STRONG_BULLISH 25,105 · BULLISH 2,362 · BEARISH 403 · STRONG_BEARISH 261 · NEUTRAL 26 |
| short_term_trend | STRONG_BULLISH 24,962 · BULLISH 2,571 · STRONG_BEARISH 350 · BEARISH 274 |
| long_term_trend | STRONG_BULLISH 21,517 · BULLISH 3,597 · BEARISH 2,253 · STRONG_BEARISH 228 · NULL 562 |
| ichimoku_signal | STRONG_BULLISH 20,299 · BULLISH 3,848 · NEUTRAL 2,527 · BEARISH 807 · STRONG_BEARISH 618 |
| smc_structure | BULLISH 24,871 · BEARISH 3,224 |
| smc_last_event | BOS_UP 14,578 · CHOCH_UP 10,293 · CHOCH_DOWN 2,267 · BOS_DOWN 957 |
| smc_sweep | SWEEP_HIGH 13,028 · SWEEP_LOW 5,061 · NULL 10,068 |
| smc_bias | BULLISH_PREMIUM 23,104 · BEARISH_PREMIUM 2,300 · BULLISH_DISCOUNT 1,329 · BEARISH_DISCOUNT 898 |
| market_regime | NEUTRAL 14,725 · BULLISH 10,273 · BEARISH 2,199 · STRONG_BULLISH 690 · STRONG_BEARISH 270 |

Top-30 picks are bullish on almost every label (89% strong medium-term
trend, 72% strong-bullish Ichimoku, 88% bullish structure), so the
informative side of a label is usually the MINORITY side. The lab therefore
tests every feature and its complement.

## Numeric quartiles used as thresholds (25 / 50 / 75 %)
| Column | EGX | US |
|---|---|---|
| relative_volume20 | 1.05 / 1.80 / 3.01 (p90 5.13) | 0.94 / 1.31 / 1.76 (p90 2.37) |
| roc20 (%) | 5.2 / 12.2 / 23.0 | 5.5 / 9.4 / 14.9 |
| volatility_annual_pct | 41.3 / 50.3 / 59.6 | 25.8 / 31.7 / 41.3 |
| ichimoku_cloud_dist_pct | 2.6 / 10.1 / 19.5 | 4.2 / 8.0 / 13.2 |
| distance_52w_high (%) | −23.3 / −11.7 / −5.4 | −11.8 / −4.8 / −1.8 |
| long_term_score | 62.6 / 80.1 / 88.1 | 57.3 / 85.8 / 94.2 |
| smc_event_bars_ago | 2 / 5 / 11 | 1 / 4 / 9 |

## Phase 1 state vector
`sql/lab/features.sql` builds `lab_features` (97 binary features per Top-30
pick, packed as a 97-char bitstring; names in `lab_feature_names`) with
labels realized_mtm / realized_zero / outcome / ret_5d / mfe_5d and slices
TRAIN (backtest < 2025) · HOLDOUT (backtest ≥ 2025) · LIVE.
