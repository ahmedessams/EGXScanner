/**
 * marketRegime.test.js
 *
 * Plain-node regression test (no framework — run with `node tests/marketRegime.test.js`)
 * for the aboveEma20/aboveEma50 population-mismatch fix in code/marketRegime.js.
 */

const assert = require("assert");
const { calculateMarketRegime } = require("../code/marketRegime");

// 8 rows: only 2 have a numeric changePct (so `total` for breadth = 2), but
// all 8 have close/ema20 both numeric and 7 of them close above ema20. Before
// the fix, pctAboveEma20 = (aboveEma20 / total) * 100 = (7 / 2) * 100 = 350%.
const rows = [
  { changePct: 1.0, close: 110, ema20: 100, ema50: 100 },
  { changePct: -0.5, close: 108, ema20: 100, ema50: 100 },
  { changePct: null, close: 107, ema20: 100, ema50: 100 },
  { changePct: null, close: 106, ema20: 100, ema50: 100 },
  { changePct: null, close: 105, ema20: 100, ema50: 100 },
  { changePct: null, close: 104, ema20: 100, ema50: 100 },
  { changePct: null, close: 103, ema20: 100, ema50: 100 },
  { changePct: null, close: 90, ema20: 100, ema50: 100 }, // below ema20/50
];

const result = calculateMarketRegime(rows, null);

assert.ok(result.pctAboveEma20 <= 100, `pctAboveEma20 must never exceed 100, got ${result.pctAboveEma20}`);
assert.ok(result.pctAboveEma50 <= 100, `pctAboveEma50 must never exceed 100, got ${result.pctAboveEma50}`);

// 7 of 8 rows have close > ema20 (all but the last) -> 7/8 * 100 = 87.5
assert.strictEqual(result.pctAboveEma20, 87.5, "pctAboveEma20 should use the EMA-availability population, not the changePct population");
assert.strictEqual(result.pctAboveEma50, 87.5, "pctAboveEma50 should use the EMA-availability population, not the changePct population");

// marketScore must still be a finite, clamped number.
assert.ok(Number.isFinite(result.marketScore));
assert.ok(result.marketScore >= 0 && result.marketScore <= 100);

// Degenerate case: rows have changePct but no EMA20/50 data at all -> must
// fall back to the neutral half-credit, not silently score as 0% breadth.
const noEmaRows = [
  { changePct: 1.0, close: 110, ema20: null, ema50: null },
  { changePct: -1.0, close: 108, ema20: null, ema50: null },
];
const noEmaResult = calculateMarketRegime(noEmaRows, null);
assert.strictEqual(noEmaResult.pctAboveEma20, null);
assert.strictEqual(noEmaResult.pctAboveEma50, null);
assert.ok(Number.isFinite(noEmaResult.marketScore), "marketScore must still compute (via neutral fallback) with no EMA data");

console.log("marketRegime.test.js: all assertions passed");
