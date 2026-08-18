/**
 * pullbackScore.js
 *
 * Independent 0-100 pullback score (spec section 16). A pullback candidate
 * is in a healthy medium-term uptrend, has retraced toward support/EMA20,
 * cooled off on RSI, and is showing declining sell-side volume — it is NOT
 * automatically disqualified by a negative daily return; a red day pulling
 * into support is often exactly the setup being looked for.
 */

const { isNumber, clamp, round } = require("./helpers");

/**
 * input: {
 *   close, ema20, ema50, ema50Rising,
 *   rsi14,
 *   nearestSupportDistancePct, support1Strength,
 *   sellVolumeDeclining,   // boolean: down-day volume shrinking vs prior down-days
 *   return1d,
 * }
 */
function calculatePullbackScore(input) {
  const {
    close, ema20, ema50, ema50Rising,
    rsi14,
    nearestSupportDistancePct, support1Strength,
    sellVolumeDeclining,
    return1d,
  } = input;

  const reasons = [];
  const warnings = [];
  let score = 0;

  // --- Medium-term trend intact (up to 30 pts) --------------------------------
  if (isNumber(ema20) && isNumber(ema50)) {
    if (ema20 > ema50) {
      score += 20;
      reasons.push({ factor: "trend", scoreContribution: 20, message: "EMA20 > EMA50 — medium-term uptrend intact" });
      if (ema50Rising) {
        score += 10;
        reasons.push({ factor: "trend", scoreContribution: 10, message: "EMA50 is rising" });
      }
    } else {
      warnings.push("EMA20 is below EMA50 — medium-term trend not confirmed bullish");
    }
  }

  // --- Proximity to EMA20 or support (up to 30 pts) ----------------------------
  if (isNumber(close) && isNumber(ema20)) {
    const distanceToEma20Pct = Math.abs(((close - ema20) / ema20) * 100);
    if (distanceToEma20Pct <= 2) {
      score += 15;
      reasons.push({ factor: "price_structure", scoreContribution: 15, message: `Price is within ${round(distanceToEma20Pct, 2)}% of EMA20` });
    }
  }
  if (isNumber(nearestSupportDistancePct) && nearestSupportDistancePct >= 0) {
    if (nearestSupportDistancePct <= 3) {
      const contribution = round(15 * (1 - nearestSupportDistancePct / 3), 2);
      score += contribution;
      reasons.push({ factor: "support", scoreContribution: contribution, message: `Price is ${round(nearestSupportDistancePct, 2)}% above nearest support` });
      if (isNumber(support1Strength) && support1Strength >= 50) {
        score += 5;
        reasons.push({ factor: "support", scoreContribution: 5, message: `Support level has strength score ${round(support1Strength, 0)}/100` });
      }
    }
  }

  // --- RSI cooled down (up to 20 pts), pullback-specific band -------------------
  if (isNumber(rsi14)) {
    if (rsi14 >= 40 && rsi14 <= 55) {
      score += 20;
      reasons.push({ factor: "rsi", value: rsi14, scoreContribution: 20, message: `RSI ${round(rsi14, 1)} has cooled into the pullback zone (40-55)` });
    } else if (rsi14 > 55 && rsi14 <= 60) {
      score += 10;
    } else if (rsi14 < 40 && rsi14 >= 30) {
      score += 8;
      warnings.push(`RSI ${round(rsi14, 1)} is cooling aggressively — watch for a deeper reversal setup instead`);
    } else if (rsi14 < 30) {
      warnings.push(`RSI ${round(rsi14, 1)} is oversold — this may be a reversal setup rather than a shallow pullback`);
    }
  }

  // --- Declining sell volume (up to 15 pts) --------------------------------------
  if (sellVolumeDeclining) {
    score += 15;
    reasons.push({ factor: "volume", scoreContribution: 15, message: "Selling volume is declining on down days" });
  }

  // --- Daily return context (informational only — no disqualification) -----------
  if (isNumber(return1d) && return1d < 0) {
    reasons.push({ factor: "daily_return", scoreContribution: 0, message: `Today's ${round(return1d, 2)}% pullback does not disqualify the setup` });
  }

  score = clamp(round(score, 2), 0, 100);
  return { score, reasons, warnings };
}

module.exports = { calculatePullbackScore };
