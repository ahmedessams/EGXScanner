/**
 * breakoutScore.js
 *
 * Independent 0-100 breakout score (spec section 14). Input is a single
 * stock's latest technicals + support/resistance snapshot; output is a
 * score plus a human-readable reasons/warnings trail and a breakout
 * classification (BREAKOUT_CONFIRMED / BREAKOUT_WATCH / NO_BREAKOUT).
 */

const { isNumber, clamp, round } = require("./helpers");

/**
 * input: {
 *   close, atr14, resistance1,
 *   ema9, ema20, ema50,
 *   rsi14, macdHistogram, macdBullishCrossover,
 *   relativeVolume20, high20,
 *   breakoutMinRvol, breakoutStrongRvol, breakoutDistancePct  // env-configurable thresholds
 * }
 */
function calculateBreakoutScore(input) {
  const {
    close, atr14, resistance1,
    ema9, ema20, ema50,
    rsi14, macdHistogram, macdBullishCrossover,
    relativeVolume20, high20,
    breakoutMinRvol = 1.5, breakoutStrongRvol = 2, breakoutDistancePct = 1.5,
  } = input;

  const reasons = [];
  const warnings = [];
  let score = 0;

  if (!isNumber(close)) {
    return { score: 0, classification: "NO_BREAKOUT", reasons, warnings: ["insufficient price data"] };
  }

  // --- Proximity to / breach of resistance (up to 25 pts) ------------------
  let distancePct = null;
  if (isNumber(resistance1)) {
    distancePct = ((resistance1 - close) / close) * 100;
    if (distancePct <= 0) {
      score += 25;
      reasons.push({ factor: "resistance", scoreContribution: 25, message: `Price has broken above resistance (${round(resistance1, 4)})` });
    } else if (distancePct <= breakoutDistancePct) {
      const contribution = round(25 * (1 - distancePct / breakoutDistancePct), 2);
      score += contribution;
      reasons.push({ factor: "resistance", scoreContribution: contribution, message: `Price is ${round(distancePct, 2)}% below resistance (${round(resistance1, 4)})` });
    }
  }

  // --- Relative volume (up to 25 pts) --------------------------------------
  if (isNumber(relativeVolume20)) {
    if (relativeVolume20 >= breakoutStrongRvol) {
      score += 25;
      reasons.push({ factor: "relative_volume", value: relativeVolume20, scoreContribution: 25, message: `Relative volume is ${round(relativeVolume20, 2)}x the previous 20-session average` });
    } else if (relativeVolume20 >= breakoutMinRvol) {
      const contribution = round(15 + 10 * ((relativeVolume20 - breakoutMinRvol) / (breakoutStrongRvol - breakoutMinRvol)), 2);
      score += contribution;
      reasons.push({ factor: "relative_volume", value: relativeVolume20, scoreContribution: contribution, message: `Relative volume is ${round(relativeVolume20, 2)}x, above the ${breakoutMinRvol}x breakout threshold` });
    } else {
      warnings.push(`Relative volume ${round(relativeVolume20, 2)}x is below the ${breakoutMinRvol}x breakout threshold`);
    }
  }

  // --- Trend structure (up to 20 pts) ---------------------------------------
  if (isNumber(close) && isNumber(ema9) && isNumber(ema20) && isNumber(ema50)) {
    if (close > ema9 && ema9 > ema20 && ema20 > ema50) {
      score += 20;
      reasons.push({ factor: "trend", scoreContribution: 20, message: "EMA9 > EMA20 > EMA50 with price above all three" });
    } else if (close > ema20) {
      score += 10;
      reasons.push({ factor: "trend", scoreContribution: 10, message: "Price above EMA20 but full EMA stack not yet aligned" });
    }
  }

  // --- MACD (up to 10 pts) ---------------------------------------------------
  if (macdBullishCrossover) {
    score += 10;
    reasons.push({ factor: "macd", scoreContribution: 10, message: "MACD bullish crossover" });
  } else if (isNumber(macdHistogram) && macdHistogram > 0) {
    score += 5;
    reasons.push({ factor: "macd", scoreContribution: 5, message: "MACD histogram positive" });
  }

  // --- RSI (up to 10 pts), interpreted per section 12 ------------------------
  if (isNumber(rsi14)) {
    if (rsi14 >= 55 && rsi14 <= 70) {
      score += 10;
      reasons.push({ factor: "rsi", value: rsi14, scoreContribution: 10, message: `RSI ${round(rsi14, 1)} supports a breakout without being overextended` });
    } else if (rsi14 > 70 && rsi14 <= 80) {
      score += 4;
      warnings.push(`RSI ${round(rsi14, 1)} is elevated — reduced score applied`);
    } else if (rsi14 > 80) {
      warnings.push(`RSI ${round(rsi14, 1)} is overextended (>80)`);
    } else if (rsi14 >= 45) {
      score += 5;
    }
  }

  // --- Recent-highs confirmation (up to 10 pts) ------------------------------
  if (isNumber(high20) && close >= high20 * 0.995) {
    score += 10;
    reasons.push({ factor: "recent_highs", scoreContribution: 10, message: "Price is at or near its 20-session high" });
  }

  score = clamp(round(score, 2), 0, 100);

  // --- Classification ---------------------------------------------------------
  let classification = "NO_BREAKOUT";
  if (isNumber(resistance1) && isNumber(atr14)) {
    const buffer = Math.max(atr14 * 0.25, close * 0.003); // ATR or 0.3% buffer, whichever larger
    if (close > resistance1 + buffer) {
      classification = "BREAKOUT_CONFIRMED";
    } else if (distancePct !== null && distancePct <= breakoutDistancePct) {
      classification = "BREAKOUT_WATCH";
    }
  } else if (distancePct !== null && distancePct <= 0) {
    classification = "BREAKOUT_CONFIRMED";
  } else if (distancePct !== null && distancePct <= breakoutDistancePct) {
    classification = "BREAKOUT_WATCH";
  }

  if (classification === "NO_BREAKOUT" && !resistance1) {
    warnings.push("No resistance level available yet — classification defaults to NO_BREAKOUT");
  }

  return { score, classification, reasons, warnings };
}

module.exports = { calculateBreakoutScore };
