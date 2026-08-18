/**
 * indicators.js
 *
 * Pure technical-indicator calculations. Every function takes candles/values
 * already sorted OLDEST -> NEWEST (see helpers.sortCandlesAscending) and
 * returns an array aligned index-for-index with the input, using `null`
 * wherever there isn't enough history yet. No indicator here ever looks
 * ahead — index i only ever uses data at indices <= i (see docs/BACKTESTING.md
 * "no look-ahead" rule, spec section 30).
 */

const { isNumber, safeDivide, round } = require("./helpers");

/** Simple Moving Average over `period` closes. */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let windowSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    windowSum += isNumber(v) ? v : 0;
    if (i >= period) {
      const dropped = values[i - period];
      windowSum -= isNumber(dropped) ? dropped : 0;
    }
    if (i >= period - 1) {
      const slice = values.slice(i - period + 1, i + 1);
      if (slice.every(isNumber)) {
        out[i] = windowSum / period;
      }
    }
  }
  return out;
}

/** Exponential Moving Average, seeded with the SMA of the first `period` values. */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const seed = sma(values, period);
  let prevEma = null;
  for (let i = 0; i < values.length; i++) {
    if (!isNumber(values[i])) continue;
    if (prevEma === null) {
      if (seed[i] !== null) {
        prevEma = seed[i];
        out[i] = prevEma;
      }
      continue;
    }
    prevEma = values[i] * k + prevEma * (1 - k);
    out[i] = prevEma;
  }
  return out;
}

/** RSI (Wilder smoothing), period defaults to 14. */
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = computeRsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = computeRsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function computeRsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD: { macdLine[], signalLine[], histogram[] }. Defaults 12/26/9. */
function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);
  const macdLine = closes.map((_, i) =>
    isNumber(fastEma[i]) && isNumber(slowEma[i]) ? fastEma[i] - slowEma[i] : null
  );
  // signal line is an EMA of the MACD line itself; ema() skips nulls safely
  // because it only advances prevEma on numeric inputs.
  const signalInput = macdLine.map((v) => (v === null ? NaN : v)).map((v) => (Number.isNaN(v) ? null : v));
  const signalLine = emaSkippingNulls(signalInput, signalPeriod);
  const histogram = closes.map((_, i) =>
    isNumber(macdLine[i]) && isNumber(signalLine[i]) ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

/** Like ema() but the seed window only counts from the first non-null value. */
function emaSkippingNulls(values, period) {
  const firstValidIndex = values.findIndex(isNumber);
  const out = new Array(values.length).fill(null);
  if (firstValidIndex === -1) return out;
  const compact = values.slice(firstValidIndex).filter(isNumber);
  if (compact.length < period) return out;
  const compactEma = ema(compact, period);
  let compactIdx = 0;
  for (let i = firstValidIndex; i < values.length; i++) {
    if (!isNumber(values[i])) continue;
    out[i] = compactEma[compactIdx];
    compactIdx++;
  }
  return out;
}

/** Average True Range (Wilder smoothing), period defaults to 14. */
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  });

  let avgTr = trueRanges.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = avgTr;
  for (let i = period + 1; i < candles.length; i++) {
    avgTr = (avgTr * (period - 1) + trueRanges[i]) / period;
    out[i] = avgTr;
  }
  return out;
}

/** On-Balance Volume, cumulative. First bar seeds at 0. */
function obv(candles) {
  const out = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    const prev = out[i - 1];
    const volume = isNumber(candles[i].volume) ? candles[i].volume : 0;
    if (candles[i].close > candles[i - 1].close) out[i] = prev + volume;
    else if (candles[i].close < candles[i - 1].close) out[i] = prev - volume;
    else out[i] = prev;
  }
  return out;
}

/** Rate of Change (%) over `period` sessions. */
function roc(closes, period) {
  return closes.map((v, i) => {
    if (i < period) return null;
    return safeDivide(v - closes[i - period], closes[i - period]) === null
      ? null
      : ((v - closes[i - period]) / closes[i - period]) * 100;
  });
}

/** Rolling max of `high` over the trailing `period` sessions, inclusive of current. */
function rollingHigh(candles, period) {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const slice = candles.slice(i - period + 1, i + 1);
    return Math.max(...slice.map((c) => c.high));
  });
}

/** Rolling min of `low` over the trailing `period` sessions, inclusive of current. */
function rollingLow(candles, period) {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const slice = candles.slice(i - period + 1, i + 1);
    return Math.min(...slice.map((c) => c.low));
  });
}

/** Simple moving average of volume (same mechanics as sma()). */
function averageVolume(volumes, period) {
  return sma(volumes, period);
}

/**
 * Relative volume at index i = volume[i] / average(volume[i-period .. i-1]).
 * CRITICAL: today's volume must NEVER be included in its own denominator
 * (spec section 9 / 30). The average window ends the bar BEFORE i.
 */
function relativeVolume(volumes, period) {
  return volumes.map((v, i) => {
    if (i < period) return null;
    const priorWindow = volumes.slice(i - period, i);
    if (!priorWindow.every(isNumber)) return null;
    const avg = priorWindow.reduce((a, b) => a + b, 0) / period;
    return safeDivide(v, avg);
  });
}

/**
 * Computes the full technical_analysis row set for every bar of a sorted
 * candle series. Returns an array aligned with `candles`; each element is
 * either null (insufficient history at that index for ANY indicator we still
 * want to attempt) or a flat object matching the technical_analysis table.
 *
 * This is the function the "04-egx-technical-analysis" workflow's Code node
 * mirrors. It is intentionally tolerant: partial indicator sets (e.g. no
 * SMA200 yet for a newly listed stock) still produce a row with nulls for the
 * fields that aren't computable yet, rather than skipping the bar entirely.
 */
function calculateAllIndicators(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma100 = sma(closes, 100);
  const sma200 = sma(closes, 200);

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema100 = ema(closes, 100);
  const ema200 = ema(closes, 200);

  const rsi14 = rsi(closes, 14);
  const { macdLine, signalLine, histogram } = macd(closes, 12, 26, 9);
  const atr14 = atr(candles, 14);
  const obvSeries = obv(candles);

  const volumeSma20 = averageVolume(volumes, 20);
  const volumeSma50 = averageVolume(volumes, 50);
  const rvol20 = relativeVolume(volumes, 20);
  const rvol50 = relativeVolume(volumes, 50);

  const roc5 = roc(closes, 5);
  const roc10 = roc(closes, 10);
  const roc20 = roc(closes, 20);

  const high20 = rollingHigh(candles, 20);
  const high50 = rollingHigh(candles, 50);
  const high252 = rollingHigh(candles, 252);
  const low20 = rollingLow(candles, 20);
  const low50 = rollingLow(candles, 50);
  const low252 = rollingLow(candles, 252);

  return candles.map((c, i) => {
    const distance52wHigh = isNumber(high252[i]) ? ((c.close - high252[i]) / high252[i]) * 100 : null;
    const distance52wLow = isNumber(low252[i]) ? ((c.close - low252[i]) / low252[i]) * 100 : null;

    const trend = classifyTrend({
      close: c.close,
      ema9: ema9[i],
      ema20: ema20[i],
      ema50: ema50[i],
      ema200: ema200[i],
    });

    // History-length based data confidence (section 44): scales up to 100
    // once 252 sessions of prior data are available; never inflated for
    // thin history even if all indicators happen to compute.
    const barsOfHistory = i + 1;
    const dataConfidence = round(Math.min(100, (barsOfHistory / 252) * 100), 2);

    return {
      symbol: c.symbol,
      tradingDate: c.date,
      shortTermTrend: trend.shortTerm,
      mediumTermTrend: trend.mediumTerm,
      longTermTrend: trend.longTerm,
      dataConfidence,

      sma20: round(sma20[i], 6),
      sma50: round(sma50[i], 6),
      sma100: round(sma100[i], 6),
      sma200: round(sma200[i], 6),

      ema9: round(ema9[i], 6),
      ema20: round(ema20[i], 6),
      ema50: round(ema50[i], 6),
      ema100: round(ema100[i], 6),
      ema200: round(ema200[i], 6),

      rsi14: round(rsi14[i], 4),

      macd: round(macdLine[i], 6),
      macdSignal: round(signalLine[i], 6),
      macdHistogram: round(histogram[i], 6),

      atr14: round(atr14[i], 6),
      obv: obvSeries[i],

      volumeSma20: round(volumeSma20[i], 4),
      volumeSma50: round(volumeSma50[i], 4),

      relativeVolume20: round(rvol20[i], 4),
      relativeVolume50: round(rvol50[i], 4),

      roc5: round(roc5[i], 4),
      roc10: round(roc10[i], 4),
      roc20: round(roc20[i], 4),

      high20: high20[i],
      high50: high50[i],
      high252: high252[i],
      low20: low20[i],
      low50: low50[i],
      low252: low252[i],

      distance52wHigh: round(distance52wHigh, 4),
      distance52wLow: round(distance52wLow, 4),
    };
  });
}

/**
 * Classifies short/medium/long-term trend from EMA structure (spec section 11).
 * Deliberately does NOT require EMA200 for the medium-term read, since newer
 * EGX listings may not have 200 sessions of history yet — long-term trend
 * degrades to null (not BEARISH) when EMA200 is unavailable, so a thin
 * history never gets penalized as if it were structurally weak.
 *
 * close, ema9, ema20, ema50, ema200 are the latest bar's values (numbers or null).
 */
function classifyTrend({ close, ema9, ema20, ema50, ema200 }) {
  const result = { shortTerm: "NEUTRAL", mediumTerm: "NEUTRAL", longTerm: null };

  if (isNumber(close) && isNumber(ema9) && isNumber(ema20)) {
    if (close > ema9 && ema9 > ema20) result.shortTerm = "STRONG_BULLISH";
    else if (close > ema9 || close > ema20) result.shortTerm = "BULLISH";
    else if (close < ema9 && ema9 < ema20) result.shortTerm = "STRONG_BEARISH";
    else if (close < ema9 || close < ema20) result.shortTerm = "BEARISH";
  }

  if (isNumber(ema20) && isNumber(ema50) && isNumber(close)) {
    if (close > ema20 && ema20 > ema50) result.mediumTerm = "STRONG_BULLISH";
    else if (close > ema50) result.mediumTerm = "BULLISH";
    else if (close < ema20 && ema20 < ema50) result.mediumTerm = "STRONG_BEARISH";
    else if (close < ema50) result.mediumTerm = "BEARISH";
  }

  if (isNumber(ema50) && isNumber(ema200) && isNumber(close)) {
    if (close > ema50 && ema50 > ema200) result.longTerm = "STRONG_BULLISH";
    else if (close > ema200) result.longTerm = "BULLISH";
    else if (close < ema50 && ema50 < ema200) result.longTerm = "STRONG_BEARISH";
    else if (close < ema200) result.longTerm = "BEARISH";
    else result.longTerm = "NEUTRAL";
  }

  return result;
}

module.exports = {
  sma,
  ema,
  rsi,
  macd,
  atr,
  obv,
  roc,
  rollingHigh,
  rollingLow,
  averageVolume,
  relativeVolume,
  calculateAllIndicators,
  classifyTrend,
};
