/**
 * entryQuality.test.js
 *
 * Plain-node regression test (run with `node tests/entryQuality.test.js`) for
 * code/entryQuality.js: the Entry Quality score, its three components, and
 * the market-relative strength helpers.
 */

const assert = require("assert");
const { calculateEntryQuality, calculateRelativeStrength, medianReturn } = require("../code/entryQuality");

// Ideal entry: on the trend (0.5 ATR above EMA20), close at the high, RSI rising +10.
{
  const r = calculateEntryQuality({ close: 105, high: 105, low: 100, ema20: 100, atr14: 10, rsi14: 60, rsi14Prev3: 50 });
  assert.strictEqual(r.entryQualityScore, 100);
  assert.strictEqual(r.extensionAtr, 0.5);
  assert.strictEqual(r.closePositionPct, 100);
  assert.strictEqual(r.rsiSlope3, 10);
  assert.deepStrictEqual(r.missing, []);
}

// Chasing: 3 ATR above EMA20, close on the low, RSI rolling over -10 → 0.
{
  const r = calculateEntryQuality({ close: 130, high: 140, low: 130, ema20: 100, atr14: 10, rsi14: 60, rsi14Prev3: 70 });
  assert.strictEqual(r.entryQualityScore, 0);
  assert.strictEqual(r.extensionAtr, 3);
  assert.strictEqual(r.closePositionPct, 0);
}

// Extension decays linearly: +2 ATR is halfway between 40 and 0 → 20 pts.
{
  const r = calculateEntryQuality({ close: 120, high: 120, low: 120, ema20: 100, atr14: 10, rsi14: 50, rsi14Prev3: 50 });
  // 20 (extension) + 15 (zero-range day is neutral) + 15 (flat RSI) = 50
  assert.strictEqual(r.entryQualityScore, 50);
  assert.strictEqual(r.closePositionPct, 50);
}

// Falling knife: -2 ATR below EMA20 scores 0 on extension.
{
  const r = calculateEntryQuality({ close: 80, high: 80, low: 80, ema20: 100, atr14: 10, rsi14: 50, rsi14Prev3: 50 });
  assert.strictEqual(r.entryQualityScore, 30);
  assert.strictEqual(r.extensionAtr, -2);
}

// Missing inputs sit at the neutral midpoint and are reported, never NaN.
{
  const r = calculateEntryQuality({ close: 10, high: null, low: null, ema20: null, atr14: null, rsi14: 55, rsi14Prev3: null });
  assert.strictEqual(r.entryQualityScore, 50);
  assert.strictEqual(r.extensionAtr, null);
  assert.strictEqual(r.closePositionPct, null);
  assert.strictEqual(r.rsiSlope3, null);
  assert.deepStrictEqual(r.missing, ["extension", "closePosition", "rsiSlope"]);
}

// atr14 of 0 must not divide.
{
  const r = calculateEntryQuality({ close: 10, high: 11, low: 9, ema20: 10, atr14: 0, rsi14: 50, rsi14Prev3: 50 });
  assert.strictEqual(r.extensionAtr, null);
  assert.ok(Number.isFinite(r.entryQualityScore));
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
