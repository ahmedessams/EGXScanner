/**
 * helpers.js
 *
 * Shared low-level utilities used by every other module in /code and by the
 * equivalent n8n Code nodes. Pure functions only — no I/O, no n8n APIs — so
 * this file can be unit tested with plain `node` and pasted into a Code node
 * body unchanged (just drop the `module.exports` line).
 *
 * Candle shape (normalized, provider-agnostic — see docs/DATA_PROVIDER.md):
 * {
 *   symbol: "COMI",
 *   date: "2026-08-18",     // ISO date, trading session date
 *   open: 100.20,
 *   high: 103.10,
 *   low: 99.80,
 *   close: 102.70,
 *   volume: 12500000,
 *   tradedValue: 1270000000 // optional, derived if absent
 * }
 */

/** Returns true if v is a finite, non-NaN number. */
function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Safe division: returns null instead of Infinity/NaN when denominator is unusable. */
function safeDivide(numerator, denominator) {
  if (!isNumber(numerator) || !isNumber(denominator) || denominator === 0) {
    return null;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

/** Rounds to `decimals` places, returns null for non-numeric input. */
function round(value, decimals = 4) {
  if (!isNumber(value)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/** Percentage change from `from` to `to`. Returns null if from <= 0 or invalid. */
function pctChange(from, to) {
  if (!isNumber(from) || !isNumber(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * Validates a single raw candle. Returns { valid, errors[] }.
 * Mirrors the rules in spec section 31.
 */
function validateCandle(candle) {
  const errors = [];
  if (!candle || typeof candle !== "object") {
    return { valid: false, errors: ["candle is not an object"] };
  }
  const { symbol, date, open, high, low, close, volume } = candle;

  if (!symbol || typeof symbol !== "string") errors.push("missing/invalid symbol");
  if (!date || Number.isNaN(Date.parse(date))) errors.push("missing/invalid date");
  if (!isNumber(open)) errors.push("open is not numeric");
  if (!isNumber(high)) errors.push("high is not numeric");
  if (!isNumber(low)) errors.push("low is not numeric");
  if (!isNumber(close)) errors.push("close is not numeric");
  if (!isNumber(volume)) errors.push("volume is not numeric");

  if (isNumber(open) && isNumber(high) && isNumber(low) && isNumber(close)) {
    if (high < open) errors.push("high < open");
    if (high < close) errors.push("high < close");
    if (high < low) errors.push("high < low");
    if (low > open) errors.push("low > open");
    if (low > close) errors.push("low > close");
  }
  if (isNumber(volume) && volume < 0) errors.push("negative volume");
  if (isNumber(close) && close <= 0) errors.push("close <= 0");

  return { valid: errors.length === 0, errors };
}

/**
 * Filters an array of raw candles into { valid[], invalid[] }.
 * `invalid` entries carry the original candle plus `.errors`.
 * Zero-volume candles are valid but flagged with a warning for downstream
 * consumers (suspicious, not necessarily wrong — EGX thin names do trade zero
 * volume on quiet sessions).
 */
function validateCandles(candles) {
  const valid = [];
  const invalid = [];
  for (const candle of candles || []) {
    const { valid: ok, errors } = validateCandle(candle);
    if (ok) {
      valid.push({ ...candle, suspiciousZeroVolume: candle.volume === 0 });
    } else {
      invalid.push({ ...candle, errors });
    }
  }
  return { valid, invalid };
}

/**
 * Removes duplicate candles (same symbol+date), keeping the last occurrence
 * (assumed most recent fetch / most authoritative).
 */
function dedupeCandles(candles) {
  const map = new Map();
  for (const c of candles || []) {
    map.set(`${c.symbol}::${c.date}`, c);
  }
  return Array.from(map.values());
}

/** Sorts candles ascending by date (oldest first) — mandatory before any TA calc. */
function sortCandlesAscending(candles) {
  return [...(candles || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
}

/**
 * Derives tradedValue when the provider doesn't supply it directly.
 * Uses the session's typical price (H+L+C)/3 * volume as a reasonable proxy.
 */
function deriveTradedValue(candle) {
  if (isNumber(candle.tradedValue)) return candle.tradedValue;
  if (!isNumber(candle.high) || !isNumber(candle.low) || !isNumber(candle.close) || !isNumber(candle.volume)) {
    return null;
  }
  const typicalPrice = (candle.high + candle.low + candle.close) / 3;
  return typicalPrice * candle.volume;
}

/** Simple mean of the last `n` numeric values in `arr` (nulls skipped). Returns null if insufficient data. */
function meanOfLast(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  const slice = arr.slice(-n).filter(isNumber);
  if (slice.length < n) return null;
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** Standard deviation of the last `n` numeric values. Returns null if insufficient data. */
function stdDevOfLast(arr, n) {
  const mean = meanOfLast(arr, n);
  if (mean === null) return null;
  const slice = arr.slice(-n);
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  return Math.sqrt(variance);
}

/** Clamps a number into [min, max]. */
function clamp(value, min, max) {
  if (!isNumber(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Wraps arbitrary rows into n8n's expected item structure: [{ json: {...} }].
 * Accepts a single object or array of objects.
 */
function toN8nItems(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  return list.map((json) => ({ json }));
}

/**
 * Reads all `json` payloads out of an n8n items array back into plain objects.
 */
function fromN8nItems(items) {
  return (items || []).map((item) => item.json);
}

module.exports = {
  isNumber,
  safeDivide,
  round,
  pctChange,
  validateCandle,
  validateCandles,
  dedupeCandles,
  sortCandlesAscending,
  deriveTradedValue,
  meanOfLast,
  stdDevOfLast,
  clamp,
  toN8nItems,
  fromN8nItems,
};
