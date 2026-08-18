/**
 * overallScore.js
 *
 * Composes the final 0-100 overall_score from the independent sub-scores
 * using CONFIGURABLE weights (spec section 21 — never a flat average across
 * setup types, since a strong breakout and a strong pullback aren't
 * comparable on the same raw scale). Also performs setup classification
 * (section 22) and setup/data confidence (section 44).
 *
 * Weights are read from the `scoring_weights` table (profile 'default'
 * unless overridden) by the ranking workflow's Postgres node and passed in
 * as `weights` here — this module has no DB access of its own.
 */

const { isNumber, clamp, round } = require("./helpers");

const DEFAULT_WEIGHTS = {
  trend: 20,
  volume: 20,
  momentum: 15,
  breakout: 15,
  price_structure: 10,
  macd: 5,
  rsi: 5,
  relative_strength: 5,
  risk_reward: 5,
};

/**
 * `factors` — normalized 0-100 sub-scores for each weighted dimension:
 * { trend, volume, momentum, breakout, priceStructure, macd, rsi, relativeStrength, riskReward }
 * `subScores` — the four setup scanner outputs: { breakoutScore, momentumScore, pullbackScore, reversalScore, accumulationScore }
 * `weights` — optional override of DEFAULT_WEIGHTS (same keys, snake_case, from scoring_weights table)
 */
function calculateOverallScore(factors, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const weightSum = Object.values(w).reduce((a, b) => a + (isNumber(b) ? b : 0), 0) || 100;

  const contributions = {
    trend: safeFactor(factors.trend) * (w.trend / weightSum),
    volume: safeFactor(factors.volume) * (w.volume / weightSum),
    momentum: safeFactor(factors.momentum) * (w.momentum / weightSum),
    breakout: safeFactor(factors.breakout) * (w.breakout / weightSum),
    priceStructure: safeFactor(factors.priceStructure) * (w.price_structure / weightSum),
    macd: safeFactor(factors.macd) * (w.macd / weightSum),
    rsi: safeFactor(factors.rsi) * (w.rsi / weightSum),
    relativeStrength: safeFactor(factors.relativeStrength) * (w.relative_strength / weightSum),
    riskReward: safeFactor(factors.riskReward) * (w.risk_reward / weightSum),
  };

  const overallScore = clamp(
    round(Object.values(contributions).reduce((a, b) => a + b, 0), 2),
    0,
    100
  );

  return { overallScore, contributions };
}

function safeFactor(v) {
  return isNumber(v) ? clamp(v, 0, 100) : 0;
}

/**
 * Setup classification (spec section 22). Picks the single dominant
 * sub-score above a minimum bar; if nothing clears the bar, classifies
 * NEUTRAL, or AVOID when the stock is fundamentally disqualified
 * (illiquid / insufficient data), which callers pass explicitly.
 */
function classifySetupType(subScores, { eligible = true, minScore = 55 } = {}) {
  if (!eligible) return "AVOID";

  const candidates = [
    { type: "BREAKOUT", score: subScores.breakoutScore },
    { type: "MOMENTUM", score: subScores.momentumScore },
    { type: "PULLBACK", score: subScores.pullbackScore },
    { type: "REVERSAL", score: subScores.reversalScore },
    { type: "ACCUMULATION", score: subScores.accumulationScore },
  ].filter((c) => isNumber(c.score));

  if (!candidates.length) return "NEUTRAL";

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];

  return top.score >= minScore ? top.type : "NEUTRAL";
}

/**
 * Setup confidence (section 44): how much we trust the classification itself
 * — driven by the margin between the winning sub-score and the runner-up
 * (a clean win is more trustworthy than a narrow one) and the winning
 * sub-score's absolute strength.
 */
function calculateSetupConfidence(subScores) {
  const scores = [
    subScores.breakoutScore,
    subScores.momentumScore,
    subScores.pullbackScore,
    subScores.reversalScore,
    subScores.accumulationScore,
  ].filter(isNumber).sort((a, b) => b - a);

  if (!scores.length) return 0;
  const top = scores[0];
  const runnerUp = scores[1] ?? 0;
  const margin = top - runnerUp;

  const confidence = clamp(top * 0.6 + Math.min(margin, 40) * 1.0, 0, 100);
  return round(confidence, 2);
}

module.exports = {
  DEFAULT_WEIGHTS,
  calculateOverallScore,
  classifySetupType,
  calculateSetupConfidence,
};
