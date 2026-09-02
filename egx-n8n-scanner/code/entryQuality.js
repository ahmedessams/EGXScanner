/**
 * entryQuality.js
 *
 * Entry Quality (0-100): how good is TODAY as an entry into this stock, kept
 * separate from Setup Quality (the scanner sub-scores and overall_score,
 * which say how good the pattern is). A strong setup can still be a poor
 * entry — price already 3 ATR above its 20-day mean, closing on the day's
 * low, RSI rolling over — and the two questions were previously blended into
 * one number. Added 2026-09-02; stored on scanner_results and shown next to
 * the score. It is NOT a ranking factor until it passes the two-slice
 * walk-forward rule in scripts/scoring-lab.js (see docs/SCORING.md).
 *
 * Also computes Relative Strength vs the market: the stock's 20-day return
 * minus the median 20-day return of the market's active universe on the same
 * date (percentage points). The market median is used instead of the index
 * because index_prices only accumulates forward from when the index endpoint
 * was configured (Aug 2026) — the median is computable for every date in the
 * backtest history and is the same benchmark for every stock on a given day.
 *
 * Components of the score (each missing input sits at its neutral midpoint
 * and is listed in `missing`):
 *  - extension (40 pts): (close - ema20) / atr14. -0.5..+1.0 ATR = 40 (on or
 *    just above the trend); linear decay to 0 at +3.0 ATR (chasing) and at
 *    -2.0 ATR (well below trend — a falling knife, not a pullback).
 *  - close position (30 pts): (close - low) / (high - low) of the scan day,
 *    0..1 mapped to 0..30. A zero-range day is neutral (15).
 *  - RSI slope (30 pts): rsi14 today minus rsi14 three sessions earlier.
 *    Flat = 15; +10 points or more = 30; -10 or less = 0, linear between.
 *
 * Pure functions, no I/O — pasted verbatim into workflow 11's "Compute
 * Overall Score & Trade Structure" Code node (drop the require/exports).
 */

const { isNumber, round, clamp } = require("./helpers");

function extensionPoints(extAtr) {
  if (!isNumber(extAtr)) return 20;
  if (extAtr >= -0.5 && extAtr <= 1.0) return 40;
  if (extAtr > 1.0) return clamp(40 * (1 - (extAtr - 1.0) / 2.0), 0, 40);
  return clamp(40 * (1 - (-0.5 - extAtr) / 1.5), 0, 40);
}

function closePositionPoints(pos) {
  if (!isNumber(pos)) return 15;
  return clamp(pos, 0, 1) * 30;
}

function rsiSlopePoints(slope) {
  if (!isNumber(slope)) return 15;
  return clamp(15 + slope * 1.5, 0, 30);
}

/**
 * `close`, `high`, `low` — the scan day's bar; `ema20`, `atr14`, `rsi14` —
 * as of the scan day; `rsi14Prev3` — rsi14 three sessions before the scan day.
 * Returns { entryQualityScore, extensionAtr, closePositionPct, rsiSlope3, missing }.
 */
function calculateEntryQuality({ close, high, low, ema20, atr14, rsi14, rsi14Prev3 }) {
  const missing = [];

  const extensionAtr = isNumber(close) && isNumber(ema20) && isNumber(atr14) && atr14 > 0
    ? (close - ema20) / atr14
    : null;
  if (extensionAtr === null) missing.push("extension");

  let closePosition = null;
  if (isNumber(close) && isNumber(high) && isNumber(low)) {
    const range = high - low;
    closePosition = range > 0 ? clamp((close - low) / range, 0, 1) : 0.5;
  } else {
    missing.push("closePosition");
  }

  const rsiSlope3 = isNumber(rsi14) && isNumber(rsi14Prev3) ? rsi14 - rsi14Prev3 : null;
  if (rsiSlope3 === null) missing.push("rsiSlope");

  const score = extensionPoints(extensionAtr) + closePositionPoints(closePosition) + rsiSlopePoints(rsiSlope3);

  return {
    entryQualityScore: clamp(round(score, 2), 0, 100),
    extensionAtr: round(extensionAtr, 4),
    closePositionPct: closePosition === null ? null : round(closePosition * 100, 2),
    rsiSlope3: round(rsiSlope3, 4),
    missing,
  };
}

/**
 * Relative strength vs the market: `return20d` of the stock minus the median
 * `return20d` across the market's active universe (percentage points).
 * `marketReturn20d` is `medianReturn(allReturns)` computed once per run.
 */
function calculateRelativeStrength(return20d, marketReturn20d) {
  if (!isNumber(return20d) || !isNumber(marketReturn20d)) return null;
  return round(return20d - marketReturn20d, 4);
}

/** Median of the numeric entries of `values`; null when there are none. */
function medianReturn(values) {
  const a = (values || []).filter(isNumber).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

module.exports = { calculateEntryQuality, calculateRelativeStrength, medianReturn };
