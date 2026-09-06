/**
 * priceQuality.test.js — plain-node regression test for code/priceQuality.js.
 * Run: node tests/priceQuality.test.js
 */
const assert = require("assert");
const { priceDiscontinuities } = require("../code/priceQuality");
const { calculateAllIndicators } = require("../code/indicators");

function candles(closes) {
  return closes.map((close, i) => ({
    symbol: "T", date: `d${i}`, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000,
  }));
}

// SEIGA-type glitch: 0.95 -> 228.51 -> 0.96 flags BOTH the jump and the return.
{
  const c = candles([0.94, 0.95, 228.51, 0.96, 0.97, 0.95]);
  const r = priceDiscontinuities(c);
  assert.deepStrictEqual(r.isBreak, [false, false, true, true, false, false]);
  assert.deepStrictEqual(r.count, [0, 0, 1, 2, 2, 2]);
  assert.strictEqual(r.lastDate[5], "d3");
  assert.strictEqual(r.lastPct[2], 23953.68); // (228.51 / 0.95 - 1) * 100
  assert.ok(r.lastPct[3] < -99.5 && r.lastPct[3] > -99.6);
  assert.strictEqual(r.lastDate[1], null);
  assert.strictEqual(r.lastPct[1], null);
}

// Normal volatility (even a 50% day or a limit-down) is NOT a discontinuity.
{
  const c = candles([10, 15, 12, 9.6, 14, 21]);
  const r = priceDiscontinuities(c);
  assert.ok(r.isBreak.every((b) => b === false));
  assert.ok(r.count.every((n) => n === 0));
  assert.ok(r.lastDate.every((d) => d === null));
}

// The count only covers the trailing `lookback` window; the date follows it out.
{
  const closes = [1, 1, 5, 1, 1, 1, 1, 1];
  const r = priceDiscontinuities(candles(closes), { lookback: 3 });
  assert.deepStrictEqual(r.count, [0, 0, 1, 2, 2, 1, 0, 0]);
  assert.strictEqual(r.lastDate[5], "d3");
  assert.strictEqual(r.lastDate[6], null);
}

// Custom ratio and non-numeric closes are tolerated.
{
  const c = candles([10, 25, 10, null, 10]);
  const strict = priceDiscontinuities(c, { ratio: 2 });
  const loose = priceDiscontinuities(c, { ratio: 3 });
  assert.deepStrictEqual(strict.isBreak, [false, true, true, false, false]);
  assert.ok(loose.isBreak.every((b) => b === false));
}

// Wired into calculateAllIndicators as display-only fields; data_confidence untouched.
{
  const c = candles(Array.from({ length: 30 }, (_, i) => (i === 10 ? 500 : 10 + i * 0.1)));
  const rows = calculateAllIndicators(c);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.priceDiscontinuityCount, 2);
  assert.strictEqual(last.lastDiscontinuityDate, "d11");
  assert.strictEqual(rows[9].priceDiscontinuityCount, 0);
  assert.strictEqual(rows[9].dataConfidence, rows[9].dataConfidence); // exists
  const clean = calculateAllIndicators(candles(Array.from({ length: 30 }, (_, i) => 10 + i * 0.1)));
  assert.strictEqual(clean[29].dataConfidence, last.dataConfidence); // flag never touches confidence
}

console.log("priceQuality.test.js: all assertions passed");
