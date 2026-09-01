/**
 * riskReward.test.js
 *
 * Plain-node regression test (run with `node tests/riskReward.test.js`) for
 * the target-ladder monotonicity fix in code/riskReward.js: targets must be
 * strictly ascending (entry < T1 < T2 < T3), never a fallback below an
 * earlier resistance-based target.
 */

const assert = require("assert");
const { buildTradeStructure } = require("../code/riskReward");

function assertAscending(r, label) {
  const ladder = [r.target1, r.target2, r.target3].filter((t) => t !== null);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i] > ladder[i - 1], `${label}: ladder not ascending: ${ladder}`);
  }
  if (r.target1 !== null && r.entry !== null) {
    assert.ok(r.target1 > r.entry, `${label}: target1 must exceed entry`);
  }
}

// The AMIA 2026-08-30 inversion: one far resistance, ATR fallbacks below it.
// Old code produced T1 22.40, T2 20.94, T3 22.17 (T2/T3 BELOW T1).
{
  const r = buildTradeStructure({
    close: 19.10, atr14: 1.2267,
    resistances: [22.40, null, null], supports: [15.30, 10.60, 8.65],
    setupType: "ACCUMULATION",
  });
  assert.strictEqual(r.target1, 22.4);
  assert.ok(r.target2 > 22.4, `T2 must clear T1, got ${r.target2}`);
  assert.strictEqual(r.target3, null, "no honest third rung above T2 exists here");
  assertAscending(r, "AMIA case");
}

// No resistances: the plain ATR ladder is unchanged by the fix.
{
  const r = buildTradeStructure({
    close: 10, atr14: 1,
    resistances: [null, null, null], supports: [9, null, null],
    setupType: "MOMENTUM",
  });
  assert.deepStrictEqual([r.target1, r.target2, r.target3], [11.5, 12.5, 13.5]);
  assertAscending(r, "ATR-only case");
}

// Three real resistances pass through untouched.
{
  const r = buildTradeStructure({
    close: 10, atr14: 1,
    resistances: [11, 12, 13], supports: [9, null, null],
    setupType: "MOMENTUM",
  });
  assert.deepStrictEqual([r.target1, r.target2, r.target3], [11, 12, 13]);
  assertAscending(r, "all-resistance case");
}

// No ATR at all: missing slots stay null rather than inventing targets.
{
  const r = buildTradeStructure({
    close: 10, atr14: null,
    resistances: [12, null, null], supports: [9, null, null],
    setupType: "MOMENTUM",
  });
  assert.strictEqual(r.target1, 12);
  assert.strictEqual(r.target2, null);
  assert.strictEqual(r.target3, null);
}

console.log("riskReward.test.js: all assertions passed");

// Float-boundary regression: an ATR-fallback target at EXACTLY 1.5x ATR must
// estimate exactly 3 days (was 4 for ~half of entry/atr combinations because
// the float division landed a hair above 3.0 before ceil).
{
  let bad = 0, total = 0;
  for (let e = 1; e < 200; e += 0.37) {
    for (const atr of [0.01, 0.061994, 0.1239, 0.55, 1.23, 2.7]) {
      const r = buildTradeStructure({ close: e, atr14: atr, resistances: [null, null, null], supports: [null, null, null], setupType: "MOMENTUM" });
      total++;
      if (r.target1EstimatedDays !== 3) bad++;
    }
  }
  assert.strictEqual(bad, 0, `exact-1.5xATR distance must always be 3 days; ${bad}/${total} were not`);
}

console.log("riskReward.test.js: float-boundary assertions passed");

// markets.atr_stop_mult (2026-09-02): the stop and the ATR target ladder
// scale together, so the fallback T1 R:R is exactly 1.0 for any multiple.
{
  const base = { close: 10, atr14: 1, resistances: [null, null, null], supports: [null, null, null], setupType: "MOMENTUM" };
  const d = buildTradeStructure(base); // no multiple given -> legacy 1.5
  assert.strictEqual(d.invalidation, 8.5);
  assert.deepStrictEqual([d.target1, d.target2, d.target3], [11.5, 12.5, 13.5]);
  assert.strictEqual(d.riskRewardT1, 1);

  const e = buildTradeStructure({ ...base, atrStopMult: 2 }); // EGX setting
  assert.strictEqual(e.invalidation, 8);
  assert.deepStrictEqual([e.target1, e.target2, e.target3], [12, 13, 14]);
  assert.strictEqual(e.riskRewardT1, 1);
  assert.strictEqual(e.target1EstimatedDays, 4);

  // Real resistances are untouched by the multiple; only the stop moves.
  const f = buildTradeStructure({ ...base, resistances: [11, 12, 13], atrStopMult: 2 });
  assert.deepStrictEqual([f.target1, f.target2, f.target3], [11, 12, 13]);
  assert.strictEqual(f.invalidation, 8);
  assert.strictEqual(f.riskRewardT1, 0.5);

  // A support-based stop (BREAKOUT with s1) ignores the multiple entirely.
  const g = buildTradeStructure({ ...base, setupType: "BREAKOUT", resistances: [11, null, null], supports: [9.5, null, null], atrStopMult: 2 });
  assert.strictEqual(g.invalidation, 9.5);

  // Garbage multiples fall back to 1.5 instead of producing a null stop.
  for (const bad of [0, -1, null, undefined, "2", NaN]) {
    assert.strictEqual(buildTradeStructure({ ...base, atrStopMult: bad }).invalidation, 8.5, `bad multiple ${bad}`);
  }
}

// markets.min_target_gain_pct floor: a resistance closer than the floor is
// skipped and the ATR ladder takes over from the first rung that clears it.
{
  const r = buildTradeStructure({
    close: 100, atr14: 1, resistances: [100.5, 101.2, 106], supports: [null, null, null],
    setupType: "MOMENTUM", minGainPct: 2, atrStopMult: 2,
  });
  // 100.5 (0.5%) and 101.2 (1.2%) fail the 2% floor; 106 (6%) passes.
  // Rungs: 102 (2%) is >= floor, then 103, 104 — but a real level wins slot 0.
  assert.strictEqual(r.target1, 106);
  assert.ok(r.target2 === null || r.target2 > 106, `T2 must clear T1 or be null, got ${r.target2}`);
  assert.ok(r.target1GainPct >= 2);
}

console.log("riskReward.test.js: atr_stop_mult / min-gain-floor assertions passed");
