/**
 * smartMoney.test.js — plain-node regression test for code/smartMoney.js.
 * Run: node tests/smartMoney.test.js
 */
const assert = require("assert");
const { smartMoney } = require("../code/smartMoney");
const { calculateAllIndicators } = require("../code/indicators");

// [open, high, low, close] — hand-built so every event is checkable.
const OHLC = [
  [9.5, 12.5, 9, 9.8], // 0  (high raised so bar 2 prints no FVG)
  [10.5, 11, 10, 10.8], // 1
  [11.5, 12, 12.2, 11.8], // 2  (low raised so bar 5 becomes a swing low)
  [13, 15, 12.5, 14.5], // 3  swing high 15
  [14.2, 14.5, 13, 13.2], // 4  red
  [13.4, 13.8, 12, 12.2], // 5  red -> bullish order block, swing low 12
  [12.3, 13, 12.1, 12.9], // 6  green; swing high (3) confirmed here
  [13, 16.5, 12.9, 16], // 7  close 16 > 15 -> BOS_UP
  [16, 17, 15.5, 16.5], // 8  bullish FVG [13, 15.5]; swing low (5) confirmed
  [16.4, 18, 16.4, 17.5], // 9  swing high 18
  [17.4, 17.8, 16.8, 17], // 10
  [17, 17.5, 16.5, 16.8], // 11
  [16.7, 17.2, 16.3, 16.6], // 12 swing low 16.3; swing high (9) confirmed
  [16.6, 18.4, 16.4, 17.4], // 13 wick above 18, close below -> SWEEP_HIGH
  [17.3, 17.6, 17, 17.2], // 14
  [17.1, 17.3, 16.9, 17], // 15 swing low (12) confirmed
  [17, 17.1, 15, 15.2], // 16 close < 16.3 -> CHOCH_DOWN; bearish OB = bar 13
  [15, 15.1, 11, 11.5], // 17 mitigates bullish OB, fills bull FVG, prints bear FVG [15.1, 16.9]
];
const candles = OHLC.map(([open, high, low, close], i) => ({
  symbol: "T", date: `d${i}`, open, high, low, close, volume: 1000,
}));

const r = smartMoney(candles);

// Nothing is known before the first swing is confirmed.
for (let i = 0; i <= 5; i++) {
  assert.strictEqual(r[i].smcStructure, null);
  assert.strictEqual(r[i].smcBias, null);
  assert.strictEqual(r[i].smcRangePosPct, null);
}

// BOS_UP at bar 7 with the last red candle (bar 5) as the bullish order block.
assert.strictEqual(r[6].smcLastEvent, null);
assert.strictEqual(r[7].smcStructure, "BULLISH");
assert.strictEqual(r[7].smcLastEvent, "BOS_UP");
assert.strictEqual(r[7].smcEventBarsAgo, 0);
assert.strictEqual(r[7].smcBullObLow, 12);
assert.strictEqual(r[7].smcBullObHigh, 13.8);
assert.strictEqual(r[9].smcEventBarsAgo, 2);

// Bullish FVG printed at bar 8, dealing range 12..15 -> premium.
assert.strictEqual(r[8].smcFvgBullLow, 13);
assert.strictEqual(r[8].smcFvgBullHigh, 15.5);
assert.strictEqual(r[8].smcRangePosPct, 150);
assert.strictEqual(r[8].smcBias, "BULLISH_PREMIUM");

// Liquidity sweep above the 18 swing high at bar 13; remembered for 20 bars.
assert.strictEqual(r[12].smcSweep, null);
assert.strictEqual(r[13].smcSweep, "SWEEP_HIGH");
assert.strictEqual(r[13].smcSweepBarsAgo, 0);
assert.strictEqual(r[14].smcSweepBarsAgo, 1);
assert.strictEqual(r[13].smcStructure, "BULLISH"); // a sweep is not a break

// CHoCH down at bar 16; bearish OB = last green candle before it (bar 13).
assert.strictEqual(r[16].smcStructure, "BEARISH");
assert.strictEqual(r[16].smcLastEvent, "CHOCH_DOWN");
assert.strictEqual(r[16].smcBearObLow, 16.4);
assert.strictEqual(r[16].smcBearObHigh, 18.4);
assert.strictEqual(r[16].smcBullObLow, 12); // still unmitigated
assert.strictEqual(r[16].smcBias, "BEARISH_DISCOUNT");

// Bar 17 closes through the bullish OB and trades through the bull FVG; a bear FVG appears.
assert.strictEqual(r[17].smcBullObLow, null);
assert.strictEqual(r[17].smcFvgBullLow, null);
assert.strictEqual(r[17].smcFvgBearLow, 15.1);
assert.strictEqual(r[17].smcFvgBearHigh, 16.9);
assert.strictEqual(r[17].smcBearObLow, 16.4);

// No look-ahead: the read at bar i never changes when later bars are appended.
for (let i = 0; i < candles.length; i++) {
  assert.deepStrictEqual(smartMoney(candles.slice(0, i + 1))[i], r[i], `bar ${i} depends on the future`);
}

// Flat tape: no swings, no structure, all nulls; tolerant of missing prices.
{
  const flat = Array.from({ length: 40 }, (_, i) => ({ symbol: "T", date: `d${i}`, open: 10, high: 10, low: 10, close: 10, volume: 1 }));
  const f = smartMoney(flat);
  assert.ok(f.every((x) => x.smcStructure === null && x.smcSweep === null && x.smcFvgBullLow === null));
  const holey = candles.map((c, i) => (i === 4 ? { ...c, close: null, high: null, low: null } : c));
  assert.doesNotThrow(() => smartMoney(holey));
}

// Spread into the technical_analysis row by calculateAllIndicators.
{
  const rows = calculateAllIndicators(candles);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.smcStructure, "BEARISH");
  assert.strictEqual(last.smcLastEvent, "CHOCH_DOWN");
  assert.strictEqual(last.smcFvgBearLow, 15.1);
  assert.ok("ichimokuSignal" in last && "priceDiscontinuityCount" in last);
}

console.log("smartMoney.test.js: all assertions passed");
