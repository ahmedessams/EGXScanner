/**
 * breakoutScore.test.js
 *
 * Plain-node regression test (no framework — run with `node tests/breakoutScore.test.js`)
 * for code/breakoutScore.js.
 *
 * Note on the RVOL-interpolation guard: the enclosing `if (rvol >= strong) {...}
 * else if (rvol >= min) {...}` structure means the interpolation branch (and its
 * division by `strong - min`) can only ever execute when `strong > min` strictly
 * — so `strong <= min` can never actually reach that division in production. The
 * `rvolRange > 0 ? ... : 15` guard added alongside this test is therefore harmless
 * defensive insurance, not a fix for a reachable bug; this test instead locks in
 * that the equal/inverted-threshold boundary still resolves via the intended
 * first branch (score 25) rather than silently falling through to 0/NaN.
 */

const assert = require("assert");
const { calculateBreakoutScore } = require("../code/breakoutScore");

const baseInput = {
  close: 100,
  atr14: 2,
  resistance1: null,
  ema9: null,
  ema20: null,
  ema50: null,
  rsi14: null,
  macdHistogram: null,
  macdBullishCrossover: false,
  high20: null,
};

// Misconfigured thresholds (equal): any rvol >= breakoutMinRvol is also
// >= breakoutStrongRvol, so the first branch (flat 25pt) always wins —
// must stay a finite, non-NaN score either way.
{
  const result = calculateBreakoutScore({
    ...baseInput,
    relativeVolume20: 1.8,
    breakoutMinRvol: 1.5,
    breakoutStrongRvol: 1.5, // equal to breakoutMinRvol
  });
  assert.ok(!Number.isNaN(result.score), "score must not be NaN");
  assert.strictEqual(result.score, 25, "equal thresholds: rvol clears breakoutStrongRvol, so the flat 25pt branch applies");
}

// Inverted thresholds (strong < min): same reasoning — rvol >= min implies
// rvol >= strong, so the flat 25pt branch still applies, never the division.
{
  const result = calculateBreakoutScore({
    ...baseInput,
    relativeVolume20: 1.8,
    breakoutMinRvol: 1.5,
    breakoutStrongRvol: 1.0,
  });
  assert.ok(!Number.isNaN(result.score));
  assert.strictEqual(result.score, 25);
}

// Normal (unequal) thresholds must still interpolate exactly as before the fix.
{
  const result = calculateBreakoutScore({
    ...baseInput,
    relativeVolume20: 1.75, // halfway between 1.5 and 2.0
    breakoutMinRvol: 1.5,
    breakoutStrongRvol: 2,
  });
  assert.strictEqual(result.score, 20, "halfway between min/strong RVOL should score 15 + 10*0.5 = 20");
}

// close === 0 (isNumber(0) is true, so it reaches the resistance-distance calc)
// must not leak Infinity into the score via raw division.
{
  const result = calculateBreakoutScore({
    ...baseInput,
    close: 0,
    resistance1: 100,
    relativeVolume20: null,
  });
  assert.ok(Number.isFinite(result.score), "score must stay finite even when close === 0");
}

// classification's missing-resistance warning must key off isNumber, not truthiness.
{
  const result = calculateBreakoutScore({
    ...baseInput,
    resistance1: null,
    relativeVolume20: null,
  });
  assert.ok(
    result.warnings.some((w) => w.includes("No resistance level available")),
    "a genuinely missing resistance1 should still warn"
  );
}

console.log("breakoutScore.test.js: all assertions passed");
