/**
 * supportResistance.js
 *
 * Price-structure based support/resistance engine (spec section 10).
 * Pipeline: detect swing highs/lows -> build candidate levels -> cluster
 * nearby levels (ATR-normalized distance) -> score cluster strength ->
 * pick the 3 nearest supports (below close) and 3 nearest resistances
 * (above close).
 *
 * Only uses candles up to and including the evaluation bar — never future
 * data (spec section 30). Callers must pass an already-sorted, already-
 * truncated candle window ending at the trading date being scanned.
 */

const { isNumber, round, clamp } = require("./helpers");

/**
 * Detects swing highs/lows using a symmetric window: a swing high at index i
 * requires candles[i].high to be the strict maximum within [i-wing, i+wing];
 * a swing low requires candles[i].low to be the strict minimum in that range.
 * `wing` defaults to 2 (i.e. 2 bars on each side, a 5-bar fractal).
 *
 * Because the last `wing` bars can't be confirmed yet (no future bars to
 * compare against), the most recent `wing` candles never produce swing
 * points — this is intentional and prevents look-ahead bias from ever being
 * introduced by a caller who accidentally includes "future" bars.
 */
function detectSwingPoints(candles, wing = 2) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = wing; i < candles.length - wing; i++) {
    const windowHighs = candles.slice(i - wing, i + wing + 1).map((c) => c.high);
    const windowLows = candles.slice(i - wing, i + wing + 1).map((c) => c.low);

    const isSwingHigh = candles[i].high === Math.max(...windowHighs) &&
      windowHighs.filter((h) => h === candles[i].high).length === 1;
    const isSwingLow = candles[i].low === Math.min(...windowLows) &&
      windowLows.filter((l) => l === candles[i].low).length === 1;

    if (isSwingHigh) {
      swingHighs.push({ index: i, date: candles[i].date, price: candles[i].high, volume: candles[i].volume });
    }
    if (isSwingLow) {
      swingLows.push({ index: i, date: candles[i].date, price: candles[i].low, volume: candles[i].volume });
    }
  }

  return { swingHighs, swingLows };
}

/**
 * Clusters a list of { index, date, price, volume } points into zones.
 * Two points belong to the same cluster when their price distance is within
 * `atrThreshold` * ATR (falls back to `pctThreshold`% of price when ATR is
 * unavailable, e.g. very short history).
 */
function clusterLevels(points, referenceAtr, referencePrice, atrThreshold = 0.5, pctThreshold = 0.5) {
  if (!points.length) return [];

  const threshold = isNumber(referenceAtr) && referenceAtr > 0
    ? referenceAtr * atrThreshold
    : referencePrice * (pctThreshold / 100);

  // Reference for recency scoring must be the most recent bar INDEX across
  // all points (chronological), not derived from a price-sorted ordering.
  const latestIndex = Math.max(...points.map((p) => p.index));

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevPrice = current[current.length - 1].price;
    if (Math.abs(sorted[i].price - prevPrice) <= threshold) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  return clusters.map((cluster) => buildClusterSummary(cluster, latestIndex));
}

/**
 * Scores a cluster's strength using touches, recency, volume near the level,
 * and time separation between touches (more spread-out touches => a more
 * durable, tested level, not just one noisy consolidation).
 */
function buildClusterSummary(clusterPoints, latestIndex) {
  const price = clusterPoints.reduce((sum, p) => sum + p.price, 0) / clusterPoints.length;
  const touches = clusterPoints.length;

  const mostRecentIndex = Math.max(...clusterPoints.map((p) => p.index));
  const recencyScore = latestIndex > 0 ? Math.max(0, 1 - (latestIndex - mostRecentIndex) / latestIndex) : 0;

  const avgVolume = clusterPoints.reduce((sum, p) => sum + (isNumber(p.volume) ? p.volume : 0), 0) / touches;

  const indices = clusterPoints.map((p) => p.index).sort((a, b) => a - b);
  let avgSeparation = 0;
  if (indices.length > 1) {
    let totalSep = 0;
    for (let i = 1; i < indices.length; i++) totalSep += indices[i] - indices[i - 1];
    avgSeparation = totalSep / (indices.length - 1);
  }
  const separationScore = Math.min(1, avgSeparation / 20); // 20+ bars apart = fully "tested over time"

  // Weighted composite, 0-100.
  const touchScore = Math.min(1, touches / 4); // 4+ touches saturates
  const strength =
    touchScore * 40 +
    recencyScore * 25 +
    separationScore * 20 +
    Math.min(1, avgVolume > 0 ? 1 : 0) * 15;

  return {
    price: round(price, 6),
    touches,
    strength: round(clamp(strength, 0, 100), 2),
    avgVolume: round(avgVolume, 2),
    lastTouchIndex: mostRecentIndex,
  };
}

/**
 * Main entry point. `candles` must already be truncated to the lookback
 * window ending at the scan date (spec: ~100-250 sessions, configurable via
 * SUPPORT_RESISTANCE_LOOKBACK). `latestAtr` is the ATR14 value for the last
 * bar (used for clustering distance); pass null to fall back to % clustering.
 *
 * Returns the row shape matching the support_resistance table.
 */
function calculateSupportResistance(candles, latestAtr, wing = 2) {
  if (!Array.isArray(candles) || candles.length < wing * 2 + 3) {
    return {
      support1: null, support2: null, support3: null,
      resistance1: null, resistance2: null, resistance3: null,
      support1Strength: null, support2Strength: null, support3Strength: null,
      resistance1Strength: null, resistance2Strength: null, resistance3Strength: null,
      nearestSupportDistancePct: null, nearestResistanceDistancePct: null,
    };
  }

  const closePrice = candles[candles.length - 1].close;
  const { swingHighs, swingLows } = detectSwingPoints(candles, wing);

  const resistanceClusters = clusterLevels(swingHighs, latestAtr, closePrice)
    .filter((c) => c.price > closePrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  const supportClusters = clusterLevels(swingLows, latestAtr, closePrice)
    .filter((c) => c.price < closePrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);

  const [r1, r2, r3] = resistanceClusters;
  const [s1, s2, s3] = supportClusters;

  const nearestResistanceDistancePct = r1 ? ((r1.price - closePrice) / closePrice) * 100 : null;
  const nearestSupportDistancePct = s1 ? ((closePrice - s1.price) / closePrice) * 100 : null;

  return {
    support1: s1 ? s1.price : null,
    support2: s2 ? s2.price : null,
    support3: s3 ? s3.price : null,
    resistance1: r1 ? r1.price : null,
    resistance2: r2 ? r2.price : null,
    resistance3: r3 ? r3.price : null,

    support1Strength: s1 ? s1.strength : null,
    support2Strength: s2 ? s2.strength : null,
    support3Strength: s3 ? s3.strength : null,

    resistance1Strength: r1 ? r1.strength : null,
    resistance2Strength: r2 ? r2.strength : null,
    resistance3Strength: r3 ? r3.strength : null,

    nearestSupportDistancePct: round(nearestSupportDistancePct, 4),
    nearestResistanceDistancePct: round(nearestResistanceDistancePct, 4),
  };
}

module.exports = {
  detectSwingPoints,
  clusterLevels,
  calculateSupportResistance,
};
