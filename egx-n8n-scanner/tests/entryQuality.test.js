/**
 * entryQuality.test.js
 *
 * Plain-node regression test (run with `node tests/entryQuality.test.js`) for
 * code/entryQuality.js v2: the empirical Entry Quality score, its components,
 * the US variant, and the market-relative strength helpers.
 */

const assert = require("assert");
const { calculateEntryQuality, calculateRelativeStrength, medianReturn, zoneOf } = require("../code/entryQuality");

// Best measured entry on EGX: 4.5 ATR extended, RVOL 3, RSI +12 in 3 sessions,
// close at the high, premium zone → every component at its maximum.
{
  const r = calculateEntryQuality({ close: 145, high: 145, low: 140, ema20: 100, atr14: 10, rsi14: 62, rsi14Prev3: 50, relativeVolume20: 3, smcBias: "BULLISH_PREMIUM" });
  assert.strictEqual(r.entryQualityScore, 100);
  assert.strictEqual(r.extensionAtr, 4.5);
  assert.strictEqual(r.closePositionPct, 100);
  assert.strictEqual(r.rsiSlope3, 12);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.components, { extension: 30, relativeVolume: 20, rsiSlope: 20, closePosition: 15, zone: 15 });
}

// v1's "ideal" entry (0.5 ATR above trend) is only an average entry in v2:
// 8 (extension) + 20 (RVOL 3) + 20 (RSI +10) + 15 (close at high) + 15 (premium) = 78.
{
  const r = calculateEntryQuality({ close: 105, high: 105, low: 100, ema20: 100, atr14: 10, rsi14: 60, rsi14Prev3: 50, relativeVolume20: 3, smcBias: "BULLISH_PREMIUM" });
  assert.strictEqual(r.entryQualityScore, 78);
}

// Worst measured entry: below the trend, dry volume, RSI rolling over, close on
// the low, discount zone → 0.
{
  const r = calculateEntryQuality({ close: 80, high: 90, low: 80, ema20: 100, atr14: 10, rsi14: 40, rsi14Prev3: 50, relativeVolume20: 0.5, smcBias: "BEARISH_DISCOUNT" });
  assert.strictEqual(r.entryQualityScore, 0);
  assert.strictEqual(r.extensionAtr, -2);
  assert.strictEqual(r.closePositionPct, 0);
}

// Extension ladder is monotonic: 0.5 → 8, 1.5 → 14, 2.5 → 18, 3.5 → 25, 4.5 → 30.
{
  const at = (ext) => calculateEntryQuality({ close: 100 + ext * 10, high: 200, low: 0, ema20: 100, atr14: 10, rsi14: 50, rsi14Prev3: 50, relativeVolume20: 1.5, smcBias: "BULLISH_PREMIUM" }).components.extension;
  assert.deepStrictEqual([0.5, 1.5, 2.5, 3.5, 4.5].map(at), [8, 14, 18, 25, 30]);
}

// Missing inputs sit at the component midpoints and are reported, never NaN:
// 15 + 10 + 10 + 7.5 + 8 = 50.5.
{
  const r = calculateEntryQuality({ close: 10, high: null, low: null, ema20: null, atr14: null, rsi14: 55, rsi14Prev3: null, relativeVolume20: null, smcBias: null });
  assert.strictEqual(r.entryQualityScore, 50.5);
  assert.strictEqual(r.extensionAtr, null);
  assert.strictEqual(r.closePositionPct, null);
  assert.strictEqual(r.rsiSlope3, null);
  assert.deepStrictEqual(r.missing, ["extension", "relativeVolume", "rsiSlope", "closePosition", "zone"]);
}

// Zero-range day is a neutral close position (7.5 pts); atr14 of 0 must not divide.
{
  const r = calculateEntryQuality({ close: 10, high: 10, low: 10, ema20: 10, atr14: 0, rsi14: 50, rsi14Prev3: 50, relativeVolume20: 2, smcBias: "BULLISH_PREMIUM" });
  assert.strictEqual(r.extensionAtr, null);
  assert.strictEqual(r.closePositionPct, 50);
  assert.strictEqual(r.components.closePosition, 7.5);
  assert.ok(Number.isFinite(r.entryQualityScore));
}

// US: relative volume is the only component with a measured signal.
{
  const hi = calculateEntryQuality({ market: "US", close: 145, high: 145, low: 140, ema20: 100, atr14: 10, rsi14: 62, rsi14Prev3: 50, relativeVolume20: 3, smcBias: "BULLISH_PREMIUM" });
  const lo = calculateEntryQuality({ market: "US", close: 145, high: 145, low: 140, ema20: 100, atr14: 10, rsi14: 62, rsi14Prev3: 50, relativeVolume20: 0.5, smcBias: "BULLISH_PREMIUM" });
  const unknown = calculateEntryQuality({ market: "US", close: 10, relativeVolume20: null });
  assert.strictEqual(hi.entryQualityScore, 85);
  assert.strictEqual(lo.entryQualityScore, 15);
  assert.strictEqual(unknown.entryQualityScore, 50);
}

// Zone parsing.
{
  assert.strictEqual(zoneOf("BULLISH_PREMIUM"), "PREMIUM");
  assert.strictEqual(zoneOf("BEARISH_DISCOUNT"), "DISCOUNT");
  assert.strictEqual(zoneOf(null), null);
  assert.strictEqual(zoneOf("SOMETHING_ELSE"), null);
}

// Relative strength: stock +8%, market median +3% → +5 points; even-length median.
{
  assert.strictEqual(medianReturn([1, 5, 3, 7]), 4);
  assert.strictEqual(medianReturn([1, null, 3, "x"]), 2);
  assert.strictEqual(medianReturn([]), null);
  assert.strictEqual(calculateRelativeStrength(8, 3), 5);
  assert.strictEqual(calculateRelativeStrength(8, null), null);
  assert.strictEqual(calculateRelativeStrength(null, 3), null);
}

console.log("entryQuality.test.js: all assertions passed");
