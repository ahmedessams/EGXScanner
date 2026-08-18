/**
 * sampleData.js
 *
 * SYNTHETIC TEST DATA — NOT REAL EGX MARKET DATA.
 *
 * Deterministic, generated OHLCV candles for exercising code/*.js locally
 * (unit tests, manual smoke tests) without needing a live provider
 * connection. Mildly oscillating around a slow uptrend so support/resistance
 * clustering, RSI, and MACD all produce non-degenerate output — a pure
 * monotonic trend or pure noise series would leave several code paths
 * (e.g. swing-low clustering) untested.
 *
 * Usage:
 *   const { generateSyntheticCandles } = require('./sampleData');
 *   const candles = generateSyntheticCandles(260, 'TESTSTOCK');
 */

function generateSyntheticCandles(count = 260, symbol = 'TESTSTOCK', startDate = '2025-01-01') {
  const candles = [];
  const start = new Date(startDate);

  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);

    // Base price oscillates in a band (~10%) around a slow uptrend.
    const base = 20 + Math.sin(i / 12) * 2.5 + (i / count) * 3;
    const noise = Math.sin(i * 7.3) * 0.4 + Math.cos(i * 3.1) * 0.2;

    const close = Math.round((base + noise) * 100) / 100;
    const open = Math.round((close - noise * 0.3) * 100) / 100;
    const high = Math.round((Math.max(open, close) + Math.abs(Math.sin(i * 5.5)) * 0.3) * 100) / 100;
    const low = Math.round((Math.min(open, close) - Math.abs(Math.cos(i * 4.2)) * 0.3) * 100) / 100;

    // Occasional volume spikes (every ~17 sessions) to exercise RVOL/breakout logic.
    const spike = i % 17 === 0 ? 2.5 : 1;
    const volume = Math.round((300000 + Math.abs(Math.sin(i * 2.1)) * 400000) * spike);

    candles.push({
      symbol,
      date: date.toISOString().slice(0, 10),
      open, high, low, close, volume,
      tradedValue: Math.round(((high + low + close) / 3) * volume),
    });
  }

  return candles;
}

/** A short (30-row) fixture with a couple of deliberately invalid rows, for exercising helpers.validateCandles / dedupeCandles. */
function generateFixtureWithBadRows(symbol = 'TESTBAD') {
  const good = generateSyntheticCandles(30, symbol);
  const bad = [
    { ...good[5] }, // exact duplicate of an existing date -> exercises dedupeCandles
    { symbol, date: good[10].date, open: 10, high: 9, low: 8, close: 9.5, volume: 1000 }, // high < open -> invalid
    { symbol, date: good[15].date, open: 10, high: 12, low: 11, close: 11.5, volume: 1000 }, // low > open -> invalid
    { symbol, date: good[20].date, open: 10, high: 12, low: 9, close: 11, volume: -500 }, // negative volume -> invalid
    { symbol, date: 'not-a-date', open: 10, high: 12, low: 9, close: 11, volume: 1000 }, // invalid date -> invalid
  ];
  return [...good, ...bad];
}

module.exports = { generateSyntheticCandles, generateFixtureWithBadRows };
