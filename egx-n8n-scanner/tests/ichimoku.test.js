/**
 * ichimoku.test.js — plain-node regression test for code/ichimoku.js.
 * Run: node tests/ichimoku.test.js
 */
const assert = require("assert");
const { ichimoku, cloudDistancePct, ichimokuSignal } = require("../code/ichimoku");
const { calculateAllIndicators } = require("../code/indicators");

function candles(fn, n) {
  return Array.from({ length: n }, (_, i) => {
    const close = fn(i);
    return { symbol: "T", date: `d${i}`, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}

// Linear riser: hand-computable midpoints, cloud below price, strong bullish.
{
  const c = candles((i) => 100 + i, 120);
  const r = ichimoku(c);
  const i = 119;
  assert.strictEqual(r.tenkan[i], 215);        // (220 + 210) / 2
  assert.strictEqual(r.kijun[i], 206.5);       // (220 + 193) / 2
  assert.strictEqual(r.senkouB[i], 167.5);     // bars 42..93: (194 + 141) / 2
  assert.strictEqual(r.senkouA[i], 184.75);    // (tenkan[93] + kijun[93]) / 2
  assert.ok(r.cloudDistPct[i] > 15 && r.cloudDistPct[i] < 16);
  assert.strictEqual(r.signal[i], "STRONG_BULLISH");
}

// Warm-up: the cloud needs 52 + 26 bars; nothing before bar 77 has one.
{
  const c = candles((i) => 100 + i, 120);
  const r = ichimoku(c);
  assert.strictEqual(r.senkouA[50], null);     // kijun(26) + displacement(26) - 1
  assert.notStrictEqual(r.senkouA[51], null);
  assert.strictEqual(r.senkouB[76], null);     // senkouB(52) + displacement(26) - 1
  assert.strictEqual(r.cloudDistPct[76], null);
  assert.strictEqual(r.signal[76], "NEUTRAL");
  assert.notStrictEqual(r.senkouB[77], null);
  assert.strictEqual(r.tenkan[7], null);
  assert.notStrictEqual(r.tenkan[8], null);
  assert.strictEqual(r.kijun[24], null);
  assert.notStrictEqual(r.kijun[25], null);
}

// No look-ahead: values at bar i must not change when later bars are appended.
{
  const full = candles((i) => 100 + 10 * Math.sin(i / 7), 200);
  const a = ichimoku(full.slice(0, 150));
  const b = ichimoku(full);
  for (let i = 0; i < 150; i++) {
    assert.strictEqual(a.senkouA[i], b.senkouA[i], `senkouA drifted at ${i}`);
    assert.strictEqual(a.senkouB[i], b.senkouB[i], `senkouB drifted at ${i}`);
    assert.strictEqual(a.signal[i], b.signal[i], `signal drifted at ${i}`);
  }
}

// Linear decliner mirrors the riser: cloud above, strong bearish, negative distance.
{
  const c = candles((i) => 300 - i, 120);
  const r = ichimoku(c);
  assert.strictEqual(r.signal[119], "STRONG_BEARISH");
  assert.ok(r.cloudDistPct[119] < 0);
}

// Cloud distance sign convention and inside-cloud neutrality.
{
  assert.ok(cloudDistancePct(110, 100, 105) > 0);
  assert.ok(cloudDistancePct(90, 100, 105) < 0);
  assert.strictEqual(cloudDistancePct(102, 100, 105), 0);
  assert.strictEqual(cloudDistancePct(102, 105, 100), 0); // span order irrelevant
  assert.strictEqual(cloudDistancePct(102, null, 100), null);
  assert.strictEqual(ichimokuSignal({ close: 102, tenkan: 1, kijun: 0, spanA: 100, spanB: 105, closeBack: 90 }), "NEUTRAL");
  // Above the cloud but tenkan below kijun -> plain BULLISH, not STRONG.
  assert.strictEqual(ichimokuSignal({ close: 110, tenkan: 100, kijun: 101, spanA: 100, spanB: 105, closeBack: 90 }), "BULLISH");
  // Above the cloud, cross bullish, but missing 26-bar-back close -> BULLISH.
  assert.strictEqual(ichimokuSignal({ close: 110, tenkan: 102, kijun: 101, spanA: 100, spanB: 105, closeBack: null }), "BULLISH");
}

// calculateAllIndicators carries the six fields through unchanged.
{
  const rows = calculateAllIndicators(candles((i) => 100 + i, 120));
  const last = rows[rows.length - 1];
  assert.strictEqual(last.ichimokuTenkan, 215);
  assert.strictEqual(last.ichimokuSignal, "STRONG_BULLISH");
  assert.strictEqual(rows[10].ichimokuSignal, "NEUTRAL");
  assert.strictEqual(rows[10].ichimokuSenkouA, null);
  // Thin history (fewer than 9 bars) must not throw.
  const thin = calculateAllIndicators(candles((i) => 100 + i, 5));
  assert.strictEqual(thin[4].ichimokuTenkan, null);
  assert.strictEqual(thin[4].ichimokuSignal, "NEUTRAL");
}

console.log("ichimoku.test.js: all assertions passed");
