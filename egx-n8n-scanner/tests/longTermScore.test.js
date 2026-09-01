/**
 * longTermScore.test.js — plain-node regression test for longTermTechScore.
 */
const assert = require("assert");
const { longTermTechScore, sma, horizonEstimates } = require("../code/indicators");

function series(fn, n) { return Array.from({ length: n }, (_, i) => fn(i)); }
function rollingHighArr(closes, period) {
  return closes.map((_, i) => i < period - 1 ? null : Math.max(...closes.slice(i - period + 1, i + 1)));
}

// Steady riser: above rising SMA200, near its high, positive 6m/12m returns,
// low volatility -> should score very high.
{
  const closes = series((i) => 100 * Math.pow(1.001, i), 600);
  const s200 = sma(closes, 200);
  const h252 = rollingHighArr(closes, 252);
  const vol = horizonEstimates(closes).volatilityAnnualPct;
  const score = longTermTechScore(closes, s200, h252, vol);
  const last = closes.length - 1;
  assert.ok(score[last] > 90, `steady riser should score >90, got ${score[last]}`);
}

// Steady decliner: below falling SMA200, deep under its 52w high, negative
// returns -> should score low (volatility discipline may still add a little).
{
  const closes = series((i) => 100 * Math.pow(0.999, i), 600);
  const s200 = sma(closes, 200);
  const h252 = rollingHighArr(closes, 252);
  const vol = horizonEstimates(closes).volatilityAnnualPct;
  const score = longTermTechScore(closes, s200, h252, vol);
  const last = closes.length - 1;
  assert.ok(score[last] < 25, `steady decliner should score <25, got ${score[last]}`);
}

// Not enough history for SMA200 -> null, never a fabricated score.
{
  const closes = series((i) => 100 + i, 150);
  const s200 = sma(closes, 200);
  const h252 = rollingHighArr(closes, 252);
  const vol = horizonEstimates(closes).volatilityAnnualPct;
  const score = longTermTechScore(closes, s200, h252, vol);
  assert.strictEqual(score[closes.length - 1], null);
}

// Bounds: score always within [0, 100] wherever defined.
{
  const closes = series((i) => 100 * (1 + 0.3 * Math.sin(i / 15)), 700);
  const s200 = sma(closes, 200);
  const h252 = rollingHighArr(closes, 252);
  const vol = horizonEstimates(closes).volatilityAnnualPct;
  const score = longTermTechScore(closes, s200, h252, vol);
  for (const v of score) if (v !== null) assert.ok(v >= 0 && v <= 100, `out of bounds: ${v}`);
}

console.log("longTermScore.test.js: all assertions passed");
