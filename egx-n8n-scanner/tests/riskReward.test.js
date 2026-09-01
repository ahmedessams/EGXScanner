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
