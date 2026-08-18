/**
 * momentumScore.js
 *
 * Independent 0-100 momentum score (spec section 15). Rewards multi-horizon
 * positive returns with confirming trend/MACD/RSI/volume structure, then
 * applies an overextension penalty (ATR-distance from EMA20) so stocks that
 * have already run too far don't get blindly rewarded further.
 */

const { isNumber, clamp, round } = require("./helpers");

/**
 * input: {
 *   return1d, return3d, return5d, return10d, return20d,
 *   close, ema9, ema20, ema50, atr14,
 *   macdHistogram, macdBullishCrossover, rsi14,
 *   relativeVolume20,
 *   higherHighs, higherLows,   // booleans, from recent swing structure
 *   distance52wHigh             // negative % distance from 52w high
 * }
 */
function calculateMomentumScore(input) {
  const {
    return1d, return3d, return5d, return10d, return20d,
    close, ema9, ema20, ema50, atr14,
    macdHistogram, macdBullishCrossover, rsi14,
    relativeVolume20,
    higherHighs, higherLows,
    distance52wHigh,
  } = input;

  const reasons = [];
  const warnings = [];
  let score = 0;

  // --- Multi-horizon returns (up to 30 pts) ----------------------------------
  const horizonWeights = [
    { value: return1d, weight: 4, label: "1-day" },
    { value: return3d, weight: 6, label: "3-day" },
    { value: return5d, weight: 8, label: "5-day" },
    { value: return10d, weight: 6, label: "10-day" },
    { value: return20d, weight: 6, label: "20-day" },
  ];
  let returnPoints = 0;
  const positiveHorizons = [];
  for (const h of horizonWeights) {
    if (!isNumber(h.value)) continue;
    if (h.value > 0) {
      const contribution = Math.min(h.weight, h.weight * (h.value / 8)); // saturates near +8% move
      returnPoints += contribution;
      positiveHorizons.push(h.label);
    }
  }
  returnPoints = clamp(returnPoints, 0, 30);
  if (returnPoints > 0) {
    score += returnPoints;
    reasons.push({ factor: "multi_horizon_returns", scoreContribution: round(returnPoints, 2), message: `Positive returns across: ${positiveHorizons.join(", ") || "n/a"}` });
  }

  // --- Trend structure (up to 20 pts) -----------------------------------------
  if (isNumber(close) && isNumber(ema9) && isNumber(ema20) && isNumber(ema50)) {
    if (close > ema9 && ema9 > ema20 && ema20 > ema50) {
      score += 20;
      reasons.push({ factor: "trend", scoreContribution: 20, message: "Full bullish EMA stack (EMA9 > EMA20 > EMA50)" });
    } else if (close > ema20 && ema20 > ema50) {
      score += 12;
      reasons.push({ factor: "trend", scoreContribution: 12, message: "EMA20 > EMA50 with price above EMA20" });
    }
  }

  // --- MACD (up to 15 pts) -----------------------------------------------------
  if (macdBullishCrossover) {
    score += 15;
    reasons.push({ factor: "macd", scoreContribution: 15, message: "MACD bullish crossover" });
  } else if (isNumber(macdHistogram) && macdHistogram > 0) {
    score += 8;
    reasons.push({ factor: "macd", scoreContribution: 8, message: "MACD histogram positive" });
  }

  // --- RSI (up to 10 pts), momentum-specific interpretation --------------------
  if (isNumber(rsi14)) {
    if (rsi14 > 65 && rsi14 <= 72) {
      score += 10;
      reasons.push({ factor: "rsi", value: rsi14, scoreContribution: 10, message: `RSI ${round(rsi14, 1)} is strong without being extreme` });
    } else if (rsi14 >= 50 && rsi14 <= 65) {
      score += 7;
    } else if (rsi14 > 72 && rsi14 <= 80) {
      score += 2;
      warnings.push(`RSI ${round(rsi14, 1)} approaching overextended zone`);
    } else if (rsi14 > 80) {
      warnings.push(`RSI ${round(rsi14, 1)} is overextended (>80)`);
    }
  }

  // --- Relative volume (up to 10 pts) --------------------------------------
  if (isNumber(relativeVolume20)) {
    if (relativeVolume20 >= 2) {
      score += 10;
      reasons.push({ factor: "relative_volume", value: relativeVolume20, scoreContribution: 10, message: `Relative volume ${round(relativeVolume20, 2)}x confirms momentum` });
    } else if (relativeVolume20 >= 1.3) {
      score += 5;
    }
  }

  // --- Structure: higher highs / higher lows (up to 10 pts) --------------------
  if (higherHighs && higherLows) {
    score += 10;
    reasons.push({ factor: "price_structure", scoreContribution: 10, message: "Higher highs and higher lows confirmed" });
  } else if (higherHighs || higherLows) {
    score += 5;
  }

  // --- Overextension penalty (up to -20 pts) ------------------------------------
  let penalty = 0;
  if (isNumber(close) && isNumber(ema20) && isNumber(atr14) && atr14 > 0) {
    const atrDistance = (close - ema20) / atr14;
    if (atrDistance > 2.5) {
      penalty = Math.min(20, (atrDistance - 2.5) * 8);
      warnings.push(`Price is ${round(atrDistance, 2)} ATR above EMA20 — overextension penalty applied`);
    }
  }
  if (isNumber(distance52wHigh) && distance52wHigh > -1 && distance52wHigh <= 0) {
    warnings.push("Trading within 1% of the 52-week high — limited room before uncharted territory");
  }

  score = clamp(round(score - penalty, 2), 0, 100);

  return { score, reasons, warnings };
}

module.exports = { calculateMomentumScore };
