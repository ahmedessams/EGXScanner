/**
 * riskReward.js
 *
 * Derives entry/invalidation/target trade structure from real support/
 * resistance/ATR/close inputs (spec section 20). Never invents arbitrary
 * "guaranteed" targets — targets are always resistance levels, support
 * levels, or ATR multiples actually present in the data. Rejects any
 * risk/reward calculation where risk <= 0.
 */

const { isNumber, round, safeDivide } = require("./helpers");

/**
 * `close`, `atr14` — latest bar values.
 * `resistances` — [resistance1, resistance2, resistance3] (nulls allowed).
 * `supports` — [support1, support2, support3] (nulls allowed).
 * `setupType` — one of BREAKOUT | MOMENTUM | PULLBACK | REVERSAL | ACCUMULATION.
 *
 * `minGainPct` (markets.min_target_gain_pct, e.g. EGX 2 / US 1.5): the
 * minimum distance above entry for a level to count as Target 1. Added
 * 2026-08-30: a resistance 0.3% above the close is not a trade target — it
 * is reached by daily noise — yet the outcome evaluation counted every such
 * touch as a success, which let the rolled-back 08-24 calibration fill the
 * Top 10 with near-worthless targets.
 *
 * `atrStopMult` (markets.atr_stop_mult, EGX 2.0 / US 1.5): ATR multiple
 * below entry for the ATR-based stop. The ATR target ladder is derived from
 * it as (m, m+1, m+2) x ATR, so the fallback Target-1 R:R is exactly 1.0 by
 * construction whatever the multiple. Backed by the scoring-lab replay
 * (scripts/scoring-lab.js, 2026-09-02): on EGX 2.0 halved the stop-out rate
 * at an unchanged hit rate and raised mean realized gain ~25%; on US it did
 * not help, so US keeps 1.5.
 *
 * Returns { entry, invalidation, target1, target2, target3, riskRewardT1/2/3 }.
 * Any field that cannot be derived from real structure is left null rather
 * than guessed.
 */
const DEFAULT_ATR_STOP_MULT = 1.5;

function buildTradeStructure({ close, atr14, resistances = [], supports = [], setupType, minGainPct, atrStopMult }) {
  if (!isNumber(close)) {
    return emptyStructure();
  }

  const [r1, r2, r3] = resistances;
  const [s1, s2, s3] = supports;
  const atr = isNumber(atr14) ? atr14 : null;
  const stopMult = isNumber(atrStopMult) && atrStopMult > 0 ? atrStopMult : DEFAULT_ATR_STOP_MULT;

  let entry = null;
  let invalidation = null;

  switch (setupType) {
    case "BREAKOUT":
      // Entry triggers on a confirmed break above resistance1 (small buffer);
      // invalidation sits just below the breakout level / recent support.
      entry = isNumber(r1) ? r1 * 1.002 : close;
      invalidation = isNumber(s1) ? s1 : (atr ? close - atr * stopMult : null);
      break;

    case "MOMENTUM":
      entry = close;
      invalidation = atr ? close - atr * stopMult : (isNumber(s1) ? s1 : null);
      break;

    case "PULLBACK":
      entry = isNumber(s1) ? Math.max(s1, close) : close;
      invalidation = isNumber(s1) ? s1 * 0.985 : (atr ? close - atr * 1.2 : null);
      break;

    case "REVERSAL":
      entry = close;
      invalidation = isNumber(s1) ? s1 * 0.985 : (atr ? close - atr * 1.2 : null);
      break;

    default:
      entry = close;
      invalidation = atr ? close - atr * stopMult : null;
  }

  const targets = deriveTargets({
    entry: entry ?? close, close, atr, resistances: [r1, r2, r3], minGainPct,
    atrMultiples: [stopMult, stopMult + 1, stopMult + 2],
  });
  const risk = isNumber(entry) && isNumber(invalidation) ? entry - invalidation : null;

  const withRR = targets.map((t) => ({
    target: t,
    riskReward: computeRiskReward(entry, invalidation, t),
    gainPct: calculateGainPct(entry, t),
    estimatedDays: estimateDaysToTarget(entry, t, atr),
  }));

  return {
    entry: round(entry, 6),
    invalidation: round(invalidation, 6),
    target1: round(withRR[0]?.target ?? null, 6),
    target2: round(withRR[1]?.target ?? null, 6),
    target3: round(withRR[2]?.target ?? null, 6),
    riskRewardT1: round(withRR[0]?.riskReward ?? null, 4),
    riskRewardT2: round(withRR[1]?.riskReward ?? null, 4),
    riskRewardT3: round(withRR[2]?.riskReward ?? null, 4),
    riskAmount: isNumber(risk) && risk > 0 ? round(risk, 6) : null,
    target1GainPct: round(withRR[0]?.gainPct ?? null, 4),
    target2GainPct: round(withRR[1]?.gainPct ?? null, 4),
    target3GainPct: round(withRR[2]?.gainPct ?? null, 4),
    target1EstimatedDays: withRR[0]?.estimatedDays ?? null,
    target2EstimatedDays: withRR[1]?.estimatedDays ?? null,
    target3EstimatedDays: withRR[2]?.estimatedDays ?? null,
  };
}

/**
 * Potential gain (%) from entry to a target, IF that target is reached.
 * This is arithmetic on real entry/target prices, not a forecast — it says
 * nothing about whether or when the target will actually be hit.
 */
function calculateGainPct(entry, target) {
  if (!isNumber(entry) || !isNumber(target) || entry <= 0) return null;
  return ((target - entry) / entry) * 100;
}

/**
 * Rough projection of trading sessions to cover the distance to a target,
 * using the stock's own ATR14 (average daily true range) as the only speed
 * reference available. Deliberately conservative: assumes the stock closes
 * roughly HALF its average daily range in net progress toward the target
 * each session (ATR measures full high-low range, not net directional
 * movement, and price rarely trends in a straight line) — a 0.5x factor,
 * not tuned or backtested. This is a same-order-of-magnitude estimate for
 * "how far is this, in this stock's own volatility terms", not a forecast
 * of when the target will be hit, and not derived from any historical
 * track record. Returns null when there isn't enough data to estimate from.
 */
function estimateDaysToTarget(entry, target, atr14) {
  if (!isNumber(entry) || !isNumber(target) || !isNumber(atr14) || atr14 <= 0) return null;
  const distance = target - entry;
  if (distance <= 0) return null;
  const assumedDailyProgress = atr14 * 0.5;
  // Epsilon before ceil: ATR-fallback targets sit at EXACT multiples of the
  // daily-progress unit (entry + 1.5*atr over 0.5*atr = exactly 3), but the
  // float division lands a hair above the integer roughly half the time,
  // silently inflating the window by a day (confirmed live 2026-09-01:
  // ~15 of 241 stocks stored 4d for an exactly-3d distance).
  return Math.max(1, Math.ceil(distance / assumedDailyProgress - 1e-9));
}

/**
 * Targets prefer real resistance levels above entry that clear the minimum
 * meaningful distance (`minGainPct`); remaining slots fall back to ATR
 * multiples (`atrMultiples`, default 1.5x / 2.5x / 3.5x from entry) that
 * also clear it, so a target is still an evidence-based projection, never a
 * fixed arbitrary percentage. A stock so quiet that even the top rung is
 * below the floor gets no target (null) rather than an invented one.
 *
 * The ladder is strictly ascending (entry < T1 < T2 < T3): an ATR fallback
 * rung at or below the previous target is skipped rather than emitted, so a
 * single far-away real resistance at T1 can never be followed by a CHEAPER
 * "T2"/"T3" (a real inversion observed live: T1 22.40 from resistance, then
 * fallbacks 20.94/22.17 below it). Better an honest null than a fabricated
 * lower target.
 */
function deriveTargets({ entry, close, atr, resistances, minGainPct, atrMultiples = [1.5, 2.5, 3.5] }) {
  const floor = isNumber(minGainPct) && minGainPct > 0 ? entry * (1 + minGainPct / 100) : entry;
  const candidates = resistances.filter((r) => isNumber(r) && r > entry && r >= floor);
  const atrTargets = isNumber(atr)
    ? atrMultiples.map((m) => entry + atr * m).filter((t) => t > entry && t >= floor)
    : [];
  const targets = [];
  let atrIdx = 0;
  let prev = null;

  for (let i = 0; i < 3; i++) {
    let next = null;
    if (candidates[i] !== undefined && (prev === null || candidates[i] > prev)) {
      next = candidates[i];
    } else {
      while (atrIdx < atrTargets.length && prev !== null && atrTargets[atrIdx] <= prev) atrIdx++;
      if (atrIdx < atrTargets.length) next = atrTargets[atrIdx++];
    }
    targets.push(next);
    if (next !== null) prev = next;
  }
  return targets;
}

function computeRiskReward(entry, invalidation, target) {
  if (!isNumber(entry) || !isNumber(invalidation) || !isNumber(target)) return null;
  const risk = entry - invalidation;
  const reward = target - entry;
  if (risk <= 0) return null; // invalid: invalidation must be below entry
  return safeDivide(reward, risk);
}

function emptyStructure() {
  return {
    entry: null,
    invalidation: null,
    target1: null,
    target2: null,
    target3: null,
    riskRewardT1: null,
    riskRewardT2: null,
    riskRewardT3: null,
    riskAmount: null,
    target1GainPct: null,
    target2GainPct: null,
    target3GainPct: null,
    target1EstimatedDays: null,
    target2EstimatedDays: null,
    target3EstimatedDays: null,
  };
}

module.exports = {
  buildTradeStructure,
  computeRiskReward,
  calculateGainPct,
  estimateDaysToTarget,
};
