// momentumScore.test.js — the per-market over-extension penalty switch (2026-09-11).
const assert = require("assert");
const { calculateMomentumScore } = require("../code/momentumScore.js");
const base = { return1d: 2, return3d: 4, return5d: 6, return10d: 8, return20d: 12, close: 130, ema9: 120, ema20: 100, ema50: 95,
  atr14: 5, macdHistogram: 0.5, macdBullishCrossover: true, rsi14: 65, relativeVolume20: 3, higherHighs: true, higherLows: true, distance52wHigh: -5 };
// close is 6 ATR above EMA20 -> penalty = min(20, (6-2.5)*8) = 20 when on.
const on = calculateMomentumScore({ ...base });
const off = calculateMomentumScore({ ...base, overextensionPenalty: false });
assert.ok(on.warnings.some((w) => /overextension penalty applied/.test(w)), "penalty warning when on");
assert.ok(off.warnings.some((w) => /no penalty in this market/.test(w)), "context warning when off");
assert.ok(off.score >= on.score, "score without penalty must not be lower");
assert.ok(off.score - on.score <= 20 + 1e-9, "difference bounded by the 20-pt penalty");
const near = calculateMomentumScore({ ...base, close: 110 }); // 2 ATR: no penalty either way
assert.strictEqual(near.score, calculateMomentumScore({ ...base, close: 110, overextensionPenalty: false }).score);
console.log("momentumScore.test.js ok");
