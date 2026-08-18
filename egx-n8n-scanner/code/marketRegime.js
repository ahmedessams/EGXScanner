/**
 * marketRegime.js
 *
 * Market-wide breadth analysis (spec section 23). Consumes the full daily
 * snapshot (one row per active, liquid-enough stock) plus optional EGX30
 * index candles, and produces a single market_score (0-100) and
 * market_regime classification used both for the daily report header and,
 * optionally, as a contextual input to individual scanner scores.
 */

const { isNumber, round, clamp } = require("./helpers");

const REGIME_THRESHOLDS = {
  strongBullish: 75,
  bullish: 60,
  neutral: 40,
  bearish: 25,
};

/**
 * `rows`: array of { changePct, close, ema20, ema50, ema200, relativeVolume20 }
 * for every stock included in today's scan (already liquidity-filtered
 * upstream is fine, but this function itself applies no filtering).
 *
 * `index`: optional { changePct, close, ema20, ema50 } for EGX30 (or the
 * configured benchmark). Pass null when index data isn't available yet —
 * the score still computes from breadth alone, just without the index
 * component.
 */
function calculateMarketRegime(rows, index = null) {
  const valid = (rows || []).filter((r) => isNumber(r.changePct));
  const total = valid.length;

  if (total === 0) {
    return {
      advancing: 0,
      declining: 0,
      unchanged: 0,
      pctAboveEma20: null,
      pctAboveEma50: null,
      pctAboveEma200: null,
      countRvolAbove1_5: 0,
      countRvolAbove2: 0,
      averageDailyReturn: null,
      medianDailyReturn: null,
      marketScore: null,
      marketRegime: "NEUTRAL",
    };
  }

  const advancing = valid.filter((r) => r.changePct > 0).length;
  const declining = valid.filter((r) => r.changePct < 0).length;
  const unchanged = total - advancing - declining;

  const aboveEma20 = rows.filter((r) => isNumber(r.close) && isNumber(r.ema20) && r.close > r.ema20).length;
  const aboveEma50 = rows.filter((r) => isNumber(r.close) && isNumber(r.ema50) && r.close > r.ema50).length;
  const withEma200 = rows.filter((r) => isNumber(r.close) && isNumber(r.ema200));
  const aboveEma200 = withEma200.filter((r) => r.close > r.ema200).length;

  const countRvolAbove1_5 = rows.filter((r) => isNumber(r.relativeVolume20) && r.relativeVolume20 > 1.5).length;
  const countRvolAbove2 = rows.filter((r) => isNumber(r.relativeVolume20) && r.relativeVolume20 > 2).length;

  const returns = valid.map((r) => r.changePct).sort((a, b) => a - b);
  const averageDailyReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const medianDailyReturn = median(returns);

  const pctAboveEma20 = (aboveEma20 / total) * 100;
  const pctAboveEma50 = (aboveEma50 / total) * 100;
  const pctAboveEma200 = withEma200.length ? (aboveEma200 / withEma200.length) * 100 : null;

  const breadthScore =
    clamp(advancing / total, 0, 1) * 30 +
    clamp(pctAboveEma20 / 100, 0, 1) * 20 +
    clamp(pctAboveEma50 / 100, 0, 1) * 20 +
    (pctAboveEma200 !== null ? clamp(pctAboveEma200 / 100, 0, 1) * 15 : 7.5) +
    clamp(countRvolAbove1_5 / total / 0.3, 0, 1) * 15; // 30%+ of names hot = full marks

  let indexScore = null;
  if (index && isNumber(index.changePct)) {
    let s = 50 + clamp(index.changePct * 10, -30, 30);
    if (isNumber(index.close) && isNumber(index.ema20) && index.close > index.ema20) s += 10;
    if (isNumber(index.close) && isNumber(index.ema50) && index.close > index.ema50) s += 10;
    indexScore = clamp(s, 0, 100);
  }

  const marketScore = round(
    indexScore !== null ? breadthScore * 0.7 + indexScore * 0.3 : breadthScore,
    2
  );

  return {
    advancing,
    declining,
    unchanged,
    pctAboveEma20: round(pctAboveEma20, 2),
    pctAboveEma50: round(pctAboveEma50, 2),
    pctAboveEma200: pctAboveEma200 !== null ? round(pctAboveEma200, 2) : null,
    countRvolAbove1_5: countRvolAbove1_5,
    countRvolAbove2: countRvolAbove2,
    averageDailyReturn: round(averageDailyReturn, 4),
    medianDailyReturn: round(medianDailyReturn, 4),
    marketScore,
    marketRegime: classifyRegime(marketScore),
  };
}

function classifyRegime(score) {
  if (!isNumber(score)) return "NEUTRAL";
  if (score >= REGIME_THRESHOLDS.strongBullish) return "STRONG_BULLISH";
  if (score >= REGIME_THRESHOLDS.bullish) return "BULLISH";
  if (score >= REGIME_THRESHOLDS.neutral) return "NEUTRAL";
  if (score >= REGIME_THRESHOLDS.bearish) return "BEARISH";
  return "STRONG_BEARISH";
}

function median(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 : sortedValues[mid];
}

module.exports = {
  calculateMarketRegime,
  classifyRegime,
  REGIME_THRESHOLDS,
};
