/**
 * contextIndicators.js
 *
 * Bundles the display-only context modules (Ichimoku, the price-discontinuity
 * flag, Smart Money Concepts) into one per-bar object so
 * indicators.calculateAllIndicators can spread them into the
 * technical_analysis row without growing past the 500-line cap.
 *
 * Everything here is context for the dashboard / stock-detail / AI reviewer.
 * Nothing feeds overall_score, entry_quality or the /top-picks gate — see the
 * two-slice walk-forward rule in docs/SCORING.md before promoting any field.
 *
 * Embedded into workflows/04-egx-technical-analysis.json after helpers.js,
 * ichimoku.js, priceQuality.js and smartMoney.js (drop the `require` lines
 * and the `module.exports` block when pasting).
 */

const { ichimoku } = require("./ichimoku");
const { priceDiscontinuities } = require("./priceQuality");
const { smartMoney } = require("./smartMoney");

/** Array aligned with `candles` (ascending); each element spreads into a TA row. */
function contextIndicators(candles) {
  const ichi = ichimoku(candles);
  const pq = priceDiscontinuities(candles);
  const smc = smartMoney(candles);

  return candles.map((_, i) => ({
    ichimokuTenkan: ichi.tenkan[i],
    ichimokuKijun: ichi.kijun[i],
    ichimokuSenkouA: ichi.senkouA[i],
    ichimokuSenkouB: ichi.senkouB[i],
    ichimokuCloudDistPct: ichi.cloudDistPct[i],
    ichimokuSignal: ichi.signal[i],
    priceDiscontinuityCount: pq.count[i],
    lastDiscontinuityDate: pq.lastDate[i],
    lastDiscontinuityPct: pq.lastPct[i],
    ...smc[i],
  }));
}

module.exports = {
  contextIndicators,
};
