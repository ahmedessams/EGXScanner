/**
 * reversalScore.js
 *
 * Independent 0-100 reversal score (spec section 17). Looks for oversold
 * conditions near support with a volume spike and early MACD/momentum
 * improvement — kept structurally separate from momentumScore.js since the
 * two setups actively disagree on what "good RSI" and "good recent return"
 * look like.
 */

const { isNumber, clamp, round } = require("./helpers");

/**
 * input: {
 *   close, rsi14, prevRsi14,
 *   nearestSupportDistancePct,
 *   relativeVolume20,
 *   macdImproving,          // boolean: today's MACD histogram > yesterday's
 *   return1d, return3d,
 *   bullishCandle,          // boolean: hammer/bullish-engulfing style close-near-high on the reversal bar
 *   positiveDivergence,     // boolean: price lower low while RSI higher low (optional, only when robustly detectable)
 * }
 */
function calculateReversalScore(input) {
  const {
    close, rsi14, prevRsi14,
    nearestSupportDistancePct,
    relativeVolume20,
    macdImproving,
    return1d, return3d,
    bullishCandle,
    positiveDivergence,
  } = input;

  const reasons = [];
  const warnings = [];
  let score = 0;

  // --- Oversold RSI (up to 25 pts) --------------------------------------------
  if (isNumber(rsi14)) {
    if (rsi14 < 30) {
      score += 25;
      reasons.push({ factor: "rsi", value: rsi14, scoreContribution: 25, message: `RSI ${round(rsi14, 1)} is oversold` });
    } else if (rsi14 < 35) {
      score += 18;
      reasons.push({ factor: "rsi", value: rsi14, scoreContribution: 18, message: `RSI ${round(rsi14, 1)} is approaching oversold` });
    } else if (rsi14 < 40) {
      score += 8;
    } else {
      warnings.push(`RSI ${round(rsi14, 1)} is not in oversold territory — weaker reversal case`);
    }
    if (isNumber(prevRsi14) && rsi14 > prevRsi14 && rsi14 < 45) {
      score += 5;
      reasons.push({ factor: "rsi", scoreContribution: 5, message: "RSI turning up from a low base" });
    }
  }

  // --- Support proximity (up to 20 pts) ----------------------------------------
  if (isNumber(nearestSupportDistancePct) && nearestSupportDistancePct >= 0 && nearestSupportDistancePct <= 3) {
    const contribution = round(20 * (1 - nearestSupportDistancePct / 3), 2);
    score += contribution;
    reasons.push({ factor: "support", scoreContribution: contribution, message: `Price is ${round(nearestSupportDistancePct, 2)}% above nearest support` });
  }

  // --- Volume spike (up to 20 pts) -----------------------------------------------
  if (isNumber(relativeVolume20)) {
    if (relativeVolume20 >= 2) {
      score += 20;
      reasons.push({ factor: "relative_volume", value: relativeVolume20, scoreContribution: 20, message: `Volume spike ${round(relativeVolume20, 2)}x average — possible capitulation/reversal signal` });
    } else if (relativeVolume20 >= 1.3) {
      score += 10;
    }
  }

  // --- Bullish candle structure (up to 10 pts) -----------------------------------
  if (bullishCandle) {
    score += 10;
    reasons.push({ factor: "candle_structure", scoreContribution: 10, message: "Bullish reversal candle structure detected" });
  }

  // --- MACD improvement (up to 15 pts) --------------------------------------------
  if (macdImproving) {
    score += 15;
    reasons.push({ factor: "macd", scoreContribution: 15, message: "MACD histogram improving (decreasing downside momentum)" });
  }

  // --- Positive divergence (up to 10 pts), only when robustly available -----------
  if (positiveDivergence) {
    score += 10;
    reasons.push({ factor: "divergence", scoreContribution: 10, message: "Positive RSI divergence detected" });
  }

  // --- Decreasing downside momentum context ---------------------------------------
  if (isNumber(return1d) && isNumber(return3d) && return1d > 0 && return3d < 0) {
    reasons.push({ factor: "momentum_shift", scoreContribution: 0, message: "Downside 3-day momentum is stalling with a positive 1-day return" });
  }

  score = clamp(round(score, 2), 0, 100);
  return { score, reasons, warnings };
}

module.exports = { calculateReversalScore };
