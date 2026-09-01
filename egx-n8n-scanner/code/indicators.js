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

const { isNumber, safeDivide, round, clamp } = require("./helpers");

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
  // signal line is an EMA of the MACD line itself; emaSkippingNulls() only
  // advances its internal EMA on numeric inputs, so the leading nulls are safe.
  const signalLine = emaSkippingNulls(macdLine, signalPeriod);
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
 * Horizon estimates (drift + volatility projection — the standard "expected
 * move" framework professionals use when only price data is available):
 * over the trailing `lookback` sessions (up to 252, requiring at least
 * `minReturns` valid daily log returns), measure the stock's own mean daily
 * log return (drift, mu) and its standard deviation (volatility, sigma).
 * The central estimate for a horizon of h trading days is close * e^(mu*h),
 * reported as a percentage; the +/-1 sigma*sqrt(h) band (derivable from the
 * annualized volatility also returned) expresses how uncertain that center
 * is. This is a projection of the stock's own measured history — NOT a
 * forecast, and it can be negative for weak stocks by construction.
 *
 * Returns arrays aligned with `closes`, null where history is insufficient:
 * { driftAnnualPct, volatilityAnnualPct, est2wPct, est1mPct, est3mPct, est1yPct }
 * (horizons: 10 / 21 / 63 / 252 trading days).
 */
function horizonEstimates(closes, lookback = 252, minReturns = 60) {
  const n = closes.length;
  const logReturns = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (isNumber(closes[i]) && isNumber(closes[i - 1]) && closes[i] > 0 && closes[i - 1] > 0) {
      logReturns[i] = Math.log(closes[i] / closes[i - 1]);
    }
  }

  const out = {
    driftAnnualPct: new Array(n).fill(null),
    volatilityAnnualPct: new Array(n).fill(null),
    est2wPct: new Array(n).fill(null),
    est1mPct: new Array(n).fill(null),
    est3mPct: new Array(n).fill(null),
    est1yPct: new Array(n).fill(null),
  };

  for (let i = 0; i < n; i++) {
    const window = logReturns.slice(Math.max(1, i - lookback + 1), i + 1).filter(isNumber);
    const k = window.length;
    if (k < minReturns) continue;

    const mean = window.reduce((a, b) => a + b, 0) / k;
    const variance = window.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (k - 1);
    const sigma = Math.sqrt(variance);

    out.driftAnnualPct[i] = (Math.exp(mean * 252) - 1) * 100;
    out.volatilityAnnualPct[i] = sigma * Math.sqrt(252) * 100;
    out.est2wPct[i] = (Math.exp(mean * 10) - 1) * 100;
    out.est1mPct[i] = (Math.exp(mean * 21) - 1) * 100;
    out.est3mPct[i] = (Math.exp(mean * 63) - 1) * 100;
    out.est1yPct[i] = (Math.exp(mean * 252) - 1) * 100;
  }
  return out;
}

/**
 * Long-term technical quality score (0-100): a price-only "durable uptrend"
 * read for LONG-horizon holders, deliberately different from the four setup
 * scanners (which hunt short-term entries). Components:
 *   - Trend position (30): close above SMA200 (15) + SMA200 higher than 63
 *     sessions ago (15).
 *   - Consistency (20): share of the last 252 sessions that closed above
 *     their own SMA200 (needs >=60 comparable bars).
 *   - Drawdown resilience (20): distance below the 52-week high, full marks
 *     at the high, zero at 30%+ below it.
 *   - Long-horizon returns (15): positive 12-month return (8) + positive
 *     6-month return (7).
 *   - Volatility discipline (15): annualized volatility 30% or less scores
 *     full, fading to zero at 90%+.
 * Null until SMA200 exists (~200 sessions). An UNTUNED, non-backtested
 * heuristic — a screening aid for "is this in a durable uptrend?", not a
 * forecast and not investment advice.
 */
function longTermTechScore(closes, sma200, high252, volAnnualPct) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!isNumber(closes[i]) || !isNumber(sma200[i])) continue;
    let s = 0;

    if (closes[i] > sma200[i]) s += 15;
    const smaAgo = i >= 63 ? sma200[i - 63] : null;
    if (isNumber(smaAgo) && sma200[i] > smaAgo) s += 15;

    let above = 0, comparable = 0;
    for (let j = Math.max(0, i - 251); j <= i; j++) {
      if (isNumber(closes[j]) && isNumber(sma200[j])) {
        comparable++;
        if (closes[j] > sma200[j]) above++;
      }
    }
    if (comparable >= 60) s += (above / comparable) * 20;

    if (isNumber(high252[i]) && high252[i] > 0) {
      const drawdown = (high252[i] - closes[i]) / high252[i];
      s += clamp(1 - drawdown / 0.3, 0, 1) * 20;
    }

    const close252Ago = i >= 252 ? closes[i - 252] : null;
    const close126Ago = i >= 126 ? closes[i - 126] : null;
    if (isNumber(close252Ago) && close252Ago > 0 && closes[i] > close252Ago) s += 8;
    if (isNumber(close126Ago) && close126Ago > 0 && closes[i] > close126Ago) s += 7;

    if (isNumber(volAnnualPct[i])) s += clamp((90 - volAnnualPct[i]) / 60, 0, 1) * 15;

    out[i] = round(clamp(s, 0, 100), 2);
  }
  return out;
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

  const horizons = horizonEstimates(closes);
  const ltScore = longTermTechScore(closes, sma200, high252, horizons.volatilityAnnualPct);

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

      driftAnnualPct: round(horizons.driftAnnualPct[i], 4),
      volatilityAnnualPct: round(horizons.volatilityAnnualPct[i], 4),
      est2wPct: round(horizons.est2wPct[i], 4),
      est1mPct: round(horizons.est1mPct[i], 4),
      est3mPct: round(horizons.est3mPct[i], 4),
      est1yPct: round(horizons.est1yPct[i], 4),

      longTermScore: ltScore[i],
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
  horizonEstimates,
  longTermTechScore,
  calculateAllIndicators,
  classifyTrend,
};
