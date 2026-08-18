/**
 * volumeAnalysis.js
 *
 * Volume-derived metrics that don't belong in the core indicators table:
 * day-over-day / vs-average volume change percentages, cross-sectional
 * market-wide rankings, and the accumulation signal (spec sections 9, 18).
 *
 * These operate on a "market snapshot" — an array of one row per stock for
 * the scan date, each row already carrying volume/rvol/OBV fields produced
 * by 04-egx-technical-analysis. Consumed by 06-egx-volume-analysis.
 */

const { isNumber, round, pctChange, clamp } = require("./helpers");

/**
 * Given a stock's own recent volume series (oldest -> newest, last element
 * = today), computes day-over-day and vs-N-day-average volume change %.
 * The N-day averages EXCLUDE today, matching the RVOL no-look-ahead rule.
 */
function volumeChangeMetrics(volumes) {
  const n = volumes.length;
  if (n < 2) {
    return { volumeChange1dPct: null, volumeChangeVs20dPct: null, volumeChangeVs50dPct: null };
  }
  const today = volumes[n - 1];
  const yesterday = volumes[n - 2];
  const volumeChange1dPct = round(pctChange(yesterday, today), 4);

  const avg20 = averageExcludingLast(volumes, 20);
  const avg50 = averageExcludingLast(volumes, 50);

  return {
    volumeChange1dPct,
    volumeChangeVs20dPct: avg20 !== null ? round(pctChange(avg20, today), 4) : null,
    volumeChangeVs50dPct: avg50 !== null ? round(pctChange(avg50, today), 4) : null,
  };
}

function averageExcludingLast(values, period) {
  const n = values.length;
  if (n < period + 1) return null;
  const window = values.slice(n - 1 - period, n - 1);
  if (!window.every(isNumber)) return null;
  return window.reduce((a, b) => a + b, 0) / period;
}

/**
 * Ranks a market snapshot by a numeric field, descending (rank 1 = highest).
 * Rows with a non-numeric value for `field` are ranked last (null rank).
 * Returns a NEW array (does not mutate input), each row gaining `<field>Rank`.
 */
function rankBy(rows, field, rankFieldName = `${field}Rank`) {
  const withValue = rows.filter((r) => isNumber(r[field]));
  const withoutValue = rows.filter((r) => !isNumber(r[field]));

  withValue.sort((a, b) => b[field] - a[field]);

  const ranked = withValue.map((row, idx) => ({ ...row, [rankFieldName]: idx + 1 }));
  const unranked = withoutValue.map((row) => ({ ...row, [rankFieldName]: null }));

  return [...ranked, ...unranked];
}

/**
 * Produces the four ranking views required by spec section 9/36:
 * raw volume, traded value, RVOL20, RVOL50. Returns the same rows enriched
 * with all four rank fields simultaneously (single pass merge).
 */
function buildVolumeRankings(rows) {
  const byVolume = rankBy(rows, "volume", "volumeRank");
  const byTradedValue = rankBy(rows, "tradedValue", "tradedValueRank");
  const byRvol20 = rankBy(rows, "relativeVolume20", "rvol20Rank");
  const byRvol50 = rankBy(rows, "relativeVolume50", "rvol50Rank");

  const rankMap = new Map();
  for (const row of rows) rankMap.set(row.stockId, { ...row });
  for (const row of byVolume) rankMap.get(row.stockId).volumeRank = row.volumeRank;
  for (const row of byTradedValue) rankMap.get(row.stockId).tradedValueRank = row.tradedValueRank;
  for (const row of byRvol20) rankMap.get(row.stockId).rvol20Rank = row.rvol20Rank;
  for (const row of byRvol50) rankMap.get(row.stockId).rvol50Rank = row.rvol50Rank;

  return Array.from(rankMap.values());
}

/**
 * Accumulation score (spec section 18), 0-100. Rewards: rising OBV over the
 * lookback, relatively flat price action, expanding volume, closes near the
 * daily high, limited downside, and rising traded value. Every sub-factor is
 * normalized to [0,1] before weighting so the final score always lands in
 * [0,100] regardless of the instrument's price scale.
 *
 * `window` is an array of recent candles+obv (oldest -> newest), each shaped:
 * { close, high, low, volume, tradedValue, obv }. Needs >= 10 bars to be
 * meaningful; returns 0 with insufficient data rather than null, since
 * "no evidence of accumulation" is a valid, honest reading of thin data.
 */
function calculateAccumulationScore(window) {
  if (!Array.isArray(window) || window.length < 10) return 0;

  const first = window[0];
  const last = window[window.length - 1];

  // 1) OBV trend: positive slope over the window is bullish accumulation.
  const obvSlope = isNumber(first.obv) && isNumber(last.obv) && window.length > 1
    ? (last.obv - first.obv) / window.length
    : 0;
  const obvScore = clamp(obvSlope > 0 ? 1 : 0, 0, 1);

  // 2) Price flatness: small net price range relative to volatility suggests
  // quiet absorption rather than a directional trend.
  const closes = window.map((c) => c.close);
  const priceRange = (Math.max(...closes) - Math.min(...closes)) / (closes[0] || 1);
  const flatnessScore = clamp(1 - priceRange / 0.15, 0, 1); // <=15% range scores well

  // 3) Volume expansion: compare first half vs second half average volume.
  const mid = Math.floor(window.length / 2);
  const firstHalfVol = average(window.slice(0, mid).map((c) => c.volume));
  const secondHalfVol = average(window.slice(mid).map((c) => c.volume));
  const volumeExpansionScore = firstHalfVol > 0
    ? clamp((secondHalfVol - firstHalfVol) / firstHalfVol, 0, 1)
    : 0;

  // 4) Closes near daily high: average (close - low) / (high - low).
  const closeStrengths = window
    .filter((c) => c.high !== c.low)
    .map((c) => (c.close - c.low) / (c.high - c.low));
  const closeStrengthScore = closeStrengths.length
    ? clamp(average(closeStrengths), 0, 1)
    : 0.5;

  // 5) Limited downside: fraction of bars that closed higher or flat vs prior bar.
  let upOrFlatBars = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].close >= window[i - 1].close) upOrFlatBars++;
  }
  const limitedDownsideScore = clamp(upOrFlatBars / (window.length - 1), 0, 1);

  // 6) Traded value trend: rising average traded value across the window.
  const firstHalfValue = average(window.slice(0, mid).map((c) => c.tradedValue || 0));
  const secondHalfValue = average(window.slice(mid).map((c) => c.tradedValue || 0));
  const tradedValueScore = firstHalfValue > 0
    ? clamp((secondHalfValue - firstHalfValue) / firstHalfValue, 0, 1)
    : 0;

  const composite =
    obvScore * 25 +
    flatnessScore * 15 +
    volumeExpansionScore * 25 +
    closeStrengthScore * 15 +
    limitedDownsideScore * 10 +
    tradedValueScore * 10;

  return round(clamp(composite, 0, 100), 2);
}

function average(arr) {
  const valid = arr.filter(isNumber);
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

module.exports = {
  volumeChangeMetrics,
  rankBy,
  buildVolumeRankings,
  calculateAccumulationScore,
};
