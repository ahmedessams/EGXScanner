/**
 * Ichimoku Kinko Hyo — context/display indicator (NOT a ranking input).
 *
 * Pure functions over an ascending candle array; no I/O, no n8n globals.
 * Embedded into the "Calculate Indicators" Code node of
 * workflows/04-egx-technical-analysis.json after helpers.js (drop the
 * `require` line and the `module.exports` block when pasting).
 *
 * Standard settings (9 / 26 / 52, displacement 26):
 *   tenkan  = (highest high + lowest low) / 2 over the last 9 bars
 *   kijun   = same over 26 bars
 *   senkouA = (tenkan + kijun) / 2, plotted 26 bars AHEAD
 *   senkouB = (highest high + lowest low) / 2 over 52 bars, plotted 26 ahead
 *
 * Because span A/B are plotted forward, the cloud that applies to bar i was
 * computed from bar i - 26. Every value returned here for index i is the one
 * a chart shows AT bar i, so nothing uses information after bar i (no
 * look-ahead). The chikou span (close shifted back) is deliberately not
 * stored — it is the same information as `close > close[i-26]`, which feeds
 * the signal below instead.
 *
 * Needs senkouB + displacement = 78 bars before the cloud exists; values are
 * null until then and the signal reads NEUTRAL.
 */

const { isNumber, safeDivide, round } = require("./helpers");

const DEFAULT_ICHIMOKU_SETTINGS = Object.freeze({
  tenkan: 9,
  kijun: 26,
  senkouB: 52,
  displacement: 26,
});

/** Midpoint of the highest high and lowest low over the trailing window. */
function midpointLine(candles, period) {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let valid = true;
    for (let j = i - period + 1; j <= i; j++) {
      const c = candles[j];
      if (!isNumber(c.high) || !isNumber(c.low)) { valid = false; break; }
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
    out[i] = valid ? (hi + lo) / 2 : null;
  }
  return out;
}

/**
 * Signed distance from close to the nearest cloud edge, in % of close:
 *   > 0  close above the cloud top
 *   < 0  close below the cloud bottom
 *   0    close inside the cloud
 */
function cloudDistancePct(close, spanA, spanB) {
  if (!isNumber(close) || !isNumber(spanA) || !isNumber(spanB)) return null;
  const top = Math.max(spanA, spanB);
  const bottom = Math.min(spanA, spanB);
  if (close > top) return safeDivide(close - top, close) * 100;
  if (close < bottom) return safeDivide(close - bottom, close) * 100;
  return 0;
}

/**
 * Five-state read. Only price vs cloud decides bullish/bearish; the
 * tenkan/kijun cross and the 26-bar momentum (chikou proxy) upgrade it to
 * STRONG_*. Inside the cloud, or with too little history, it is NEUTRAL.
 */
function ichimokuSignal({ close, tenkan, kijun, spanA, spanB, closeBack }) {
  const dist = cloudDistancePct(close, spanA, spanB);
  if (!isNumber(dist)) return "NEUTRAL";
  if (dist === 0) return "NEUTRAL";
  const crossKnown = isNumber(tenkan) && isNumber(kijun);
  const momentumKnown = isNumber(closeBack);
  if (dist > 0) {
    return crossKnown && momentumKnown && tenkan > kijun && close > closeBack
      ? "STRONG_BULLISH" : "BULLISH";
  }
  return crossKnown && momentumKnown && tenkan < kijun && close < closeBack
    ? "STRONG_BEARISH" : "BEARISH";
}

/**
 * Returns arrays aligned with `candles` (ascending):
 * { tenkan, kijun, senkouA, senkouB, cloudDistPct, signal }
 * senkouA/senkouB[i] are the cloud values in force at bar i.
 */
function ichimoku(candles, settings = {}) {
  const s = { ...DEFAULT_ICHIMOKU_SETTINGS, ...settings };
  const n = Array.isArray(candles) ? candles.length : 0;
  const out = {
    tenkan: new Array(n).fill(null),
    kijun: new Array(n).fill(null),
    senkouA: new Array(n).fill(null),
    senkouB: new Array(n).fill(null),
    cloudDistPct: new Array(n).fill(null),
    signal: new Array(n).fill("NEUTRAL"),
  };
  if (n === 0) return out;

  const tenkan = midpointLine(candles, s.tenkan);
  const kijun = midpointLine(candles, s.kijun);
  const spanBRaw = midpointLine(candles, s.senkouB);

  for (let i = 0; i < n; i++) {
    const src = i - s.displacement; // bar whose spans are plotted at i
    const spanA = src >= 0 && isNumber(tenkan[src]) && isNumber(kijun[src])
      ? (tenkan[src] + kijun[src]) / 2 : null;
    const spanB = src >= 0 ? spanBRaw[src] : null;
    const close = candles[i].close;
    const closeBack = src >= 0 ? candles[src].close : null;

    out.tenkan[i] = round(tenkan[i], 6);
    out.kijun[i] = round(kijun[i], 6);
    out.senkouA[i] = round(spanA, 6);
    out.senkouB[i] = round(spanB, 6);
    out.cloudDistPct[i] = round(cloudDistancePct(close, spanA, spanB), 4);
    out.signal[i] = ichimokuSignal({ close, tenkan: tenkan[i], kijun: kijun[i], spanA, spanB, closeBack });
  }
  return out;
}

module.exports = {
  DEFAULT_ICHIMOKU_SETTINGS,
  midpointLine,
  cloudDistancePct,
  ichimokuSignal,
  ichimoku,
};
