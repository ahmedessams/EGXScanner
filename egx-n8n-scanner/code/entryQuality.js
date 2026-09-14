/**
 * entryQuality.js
 *
 * Entry Quality (0-100): how good is TODAY as an entry into this stock, kept
 * separate from Setup Quality (the scanner sub-scores and overall_score,
 * which say how good the pattern is). Stored on scanner_results and shown
 * next to the setup score. Display-only: NOT a ranking factor until it passes
 * the two-slice walk-forward rule in scripts/scoring-lab.js.
 *
 * v2 (2026-09-14) — EMPIRICAL. v1 (2026-09-02) awarded 40 of its 100 points
 * for sitting -0.5..+1 ATR above the EMA20 and 0 points at +3 ATR. The
 * measured EGX record says the opposite: on 13,404 evaluated Top-10 picks
 * (2021-2026), Target-1 hit rate by extension was <0 ATR 24% · 0-1 31% ·
 * 1-2 34% · 2-3 35% · 3-4 40% · 4+ 49%, and v1's top bucket (85+) was the
 * WORST bucket (+0.93%/pick vs +1.61% mid). v2 keeps only inputs that
 * predicted outcomes, with points proportional to the measured lift in
 * realized return, derived on 2021-2024 and checked out of sample on
 * 2025-2026 (hit 31-36% in the middle buckets, 48.7% / +3.01%/pick at 85+).
 * See docs/SCORING.md "Entry Quality".
 *
 * Components and points (EGX):
 *  - extension (30): (close - ema20) / atr14 → <0: 0 · 0-1: 8 · 1-2: 14 ·
 *    2-3: 18 · 3-4: 25 · 4+: 30
 *  - relative volume 20d (20): <1: 0 · 1-2.5: 10 · 2.5+: 20
 *  - RSI 3-session slope (20): <-5: 0 · -5..5: 6 · 5..10: 13 · >10: 20
 *  - close position in the day's range (15): (close - low) / (high - low) x 15
 *  - SMC zone (15): DISCOUNT 0 · PREMIUM 15 · unknown 8
 * US: only relative volume carried a signal (hit 15.7% below 1x, 27.5% at
 * 1-2.5x, 33.3% at 2.5x+; every other component was flat or inverted), so
 * the US score is relative volume alone (15 / 50 / 85).
 * A missing input sits at its component's midpoint and is listed in
 * `missing`, so a stock with no EMA yet is "unknown", not "bad".
 *
 * Pure functions, no I/O. Embedded copy lives in workflow 11's scoring node.
 */

const { isNumber, round, clamp } = require("./helpers");

const EGX_COMPONENTS = {
  extension: { midpoint: 15, points: (e) => (e < 0 ? 0 : e < 1 ? 8 : e < 2 ? 14 : e < 3 ? 18 : e < 4 ? 25 : 30) },
  relativeVolume: { midpoint: 10, points: (v) => (v < 1 ? 0 : v < 2.5 ? 10 : 20) },
  rsiSlope: { midpoint: 10, points: (s) => (s < -5 ? 0 : s < 5 ? 6 : s < 10 ? 13 : 20) },
  closePosition: { midpoint: 7.5, points: (p) => clamp(p, 0, 1) * 15 },
  zone: { midpoint: 8, points: (z) => (z === "DISCOUNT" ? 0 : z === "PREMIUM" ? 15 : 8) },
};

const US_COMPONENTS = {
  extension: { midpoint: 0, points: () => 0 },
  relativeVolume: { midpoint: 50, points: (v) => (v < 1 ? 15 : v < 2.5 ? 50 : 85) },
  rsiSlope: { midpoint: 0, points: () => 0 },
  closePosition: { midpoint: 0, points: () => 0 },
  zone: { midpoint: 0, points: () => 0 },
};

/** smc_bias is 'BULLISH_PREMIUM' / 'BEARISH_DISCOUNT' etc.; only the zone half matters here. */
function zoneOf(smcBias) {
  if (typeof smcBias !== "string") return null;
  if (smcBias.endsWith("DISCOUNT")) return "DISCOUNT";
  if (smcBias.endsWith("PREMIUM")) return "PREMIUM";
  return null;
}

/**
 * `close`, `high`, `low` — the scan day's bar; `ema20`, `atr14`, `rsi14`,
 * `relativeVolume20`, `smcBias` — as of the scan day; `rsi14Prev3` — rsi14
 * three sessions before the scan day; `market` — 'EGX' (default) or 'US'.
 * Returns { entryQualityScore, extensionAtr, closePositionPct, rsiSlope3, missing, components }.
 */
function calculateEntryQuality({ close, high, low, ema20, atr14, rsi14, rsi14Prev3, relativeVolume20, smcBias, market = "EGX" }) {
  const table = market === "US" ? US_COMPONENTS : EGX_COMPONENTS;
  const missing = [];
  const components = {};

  const extensionAtr = isNumber(close) && isNumber(ema20) && isNumber(atr14) && atr14 > 0
    ? (close - ema20) / atr14
    : null;
  if (extensionAtr === null) missing.push("extension");
  components.extension = extensionAtr === null ? table.extension.midpoint : table.extension.points(extensionAtr);

  const rvol = isNumber(relativeVolume20) ? relativeVolume20 : null;
  if (rvol === null) missing.push("relativeVolume");
  components.relativeVolume = rvol === null ? table.relativeVolume.midpoint : table.relativeVolume.points(rvol);

  const rsiSlope3 = isNumber(rsi14) && isNumber(rsi14Prev3) ? rsi14 - rsi14Prev3 : null;
  if (rsiSlope3 === null) missing.push("rsiSlope");
  components.rsiSlope = rsiSlope3 === null ? table.rsiSlope.midpoint : table.rsiSlope.points(rsiSlope3);

  let closePosition = null;
  if (isNumber(close) && isNumber(high) && isNumber(low)) {
    const range = high - low;
    closePosition = range > 0 ? clamp((close - low) / range, 0, 1) : 0.5;
  } else {
    missing.push("closePosition");
  }
  components.closePosition = closePosition === null ? table.closePosition.midpoint : table.closePosition.points(closePosition);

  const zone = zoneOf(smcBias);
  if (zone === null) missing.push("zone");
  components.zone = zone === null ? table.zone.midpoint : table.zone.points(zone);

  const score = Object.values(components).reduce((a, b) => a + b, 0);

  return {
    entryQualityScore: clamp(round(score, 2), 0, 100),
    extensionAtr: round(extensionAtr, 4),
    closePositionPct: closePosition === null ? null : round(closePosition * 100, 2),
    rsiSlope3: round(rsiSlope3, 4),
    missing,
    components,
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

module.exports = { calculateEntryQuality, calculateRelativeStrength, medianReturn, zoneOf };
