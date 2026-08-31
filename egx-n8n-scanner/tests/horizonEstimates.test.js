/**
 * horizonEstimates.test.js
 *
 * Plain-node regression test (run with `node tests/horizonEstimates.test.js`)
 * for the drift + volatility horizon projections in code/indicators.js.
 */

const assert = require("assert");
const { horizonEstimates } = require("../code/indicators");

function approx(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: got ${actual}, expected ~${expected}`);
}

// Deterministic 1%-per-day growth: drift is exactly ln(1.01)/day, volatility 0.
{
  const closes = [];
  let p = 100;
  for (let i = 0; i < 300; i++) { closes.push(p); p *= 1.01; }
  const h = horizonEstimates(closes);
  const last = closes.length - 1;

  approx(h.est2wPct[last], (Math.pow(1.01, 10) - 1) * 100, 0.01, "est2wPct");   // ~10.46%
  approx(h.est1mPct[last], (Math.pow(1.01, 21) - 1) * 100, 0.01, "est1mPct");   // ~23.24%
  approx(h.est3mPct[last], (Math.pow(1.01, 63) - 1) * 100, 0.05, "est3mPct");   // ~87.11%
  approx(h.est1yPct[last], (Math.pow(1.01, 252) - 1) * 100, 5, "est1yPct");     // ~1127%
  approx(h.volatilityAnnualPct[last], 0, 1e-6, "volatility of a constant-growth series");
  assert.strictEqual(h.est1yPct[last], h.driftAnnualPct[last], "1y estimate equals annualized drift by definition");
}

// Deterministic 0.5%-per-day decline: estimates must be NEGATIVE.
{
  const closes = [];
  let p = 100;
  for (let i = 0; i < 300; i++) { closes.push(p); p *= 0.995; }
  const h = horizonEstimates(closes);
  const last = closes.length - 1;
  assert.ok(h.est2wPct[last] < 0 && h.est1yPct[last] < 0, "declining stock must project negative");
  approx(h.est2wPct[last], (Math.pow(0.995, 10) - 1) * 100, 0.01, "declining est2wPct");
}

// Insufficient history (< 60 returns) yields null, never a fabricated value.
{
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
  const h = horizonEstimates(closes);
  const last = closes.length - 1;
  for (const key of ["est2wPct", "est1mPct", "est3mPct", "est1yPct", "driftAnnualPct", "volatilityAnnualPct"]) {
    assert.strictEqual(h[key][last], null, `${key} must be null with only ${last} returns`);
  }
}

// Non-numeric closes are skipped without crashing or poisoning the window.
{
  const closes = [];
  let p = 100;
  for (let i = 0; i < 200; i++) { closes.push(i === 50 ? null : p); p *= 1.002; }
  const h = horizonEstimates(closes);
  const last = closes.length - 1;
  assert.ok(Number.isFinite(h.est1mPct[last]), "must still compute around a data gap");
}

// Alternating +2%/-2% series: drift ~ negative tiny, volatility clearly positive.
{
  const closes = [];
  let p = 100;
  for (let i = 0; i < 300; i++) { closes.push(p); p *= (i % 2 === 0 ? 1.02 : 0.98); }
  const h = horizonEstimates(closes);
  const last = closes.length - 1;
  assert.ok(h.volatilityAnnualPct[last] > 20, "volatile series must report substantial annualized volatility");
}

console.log("horizonEstimates.test.js: all assertions passed");
