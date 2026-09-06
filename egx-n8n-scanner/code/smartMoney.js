/**
 * Smart Money Concepts (SMC) — context/display analysis (NOT a ranking input).
 *
 * Pure functions over an ascending candle array; no I/O, no n8n globals.
 * Embedded into the "Calculate Indicators" Code node of
 * workflows/04-egx-technical-analysis.json after helpers.js (drop the
 * `require` line and the `module.exports` block when pasting).
 *
 * What is computed, per bar, using only bars <= i (no look-ahead):
 *
 *   Swing points   fractal highs/lows with `swingLen` bars on each side. A
 *                  swing at bar j is only KNOWN at bar j + swingLen, so it is
 *                  registered there — never earlier.
 *   Structure      BULLISH after a close above the last unbroken swing high,
 *                  BEARISH after a close below the last unbroken swing low.
 *                  The break is a BOS (break of structure) when it continues
 *                  the current structure, a CHoCH (change of character) when
 *                  it flips it.
 *   Order blocks   the last opposite-colour candle before the move that broke
 *                  structure (bullish OB = last red candle before a BOS/CHoCH
 *                  up). Kept until price CLOSES through it (mitigated). One
 *                  active bullish and one active bearish OB are exposed.
 *   Fair value gaps three-candle imbalance: bullish when low[i] > high[i-2],
 *                  bearish when high[i] < low[i-2]. Unfilled until a later
 *                  bar trades through the whole gap; the nearest unfilled one
 *                  on each side of price is exposed.
 *   Liquidity sweep bar trades beyond the last swing high/low but closes back
 *                  inside it (stops taken, level held). SWEEP_HIGH is the
 *                  bearish grab above highs, SWEEP_LOW the bullish one.
 *   Range position close inside the dealing range [last swing low, last
 *                  swing high] in % (0 = at the low, 100 = at the high);
 *                  <= 50 is the "discount" half, > 50 the "premium" half.
 *   Bias           BULLISH_DISCOUNT / BULLISH_PREMIUM / BEARISH_PREMIUM /
 *                  BEARISH_DISCOUNT — structure + which half of the range the
 *                  close sits in. Null until a structure exists.
 *
 * None of this feeds overall_score, entry_quality or the /top-picks gate; it
 * is stored so the dashboard, the stock-detail drawer and the AI reviewer can
 * SEE it. Promoting any field to a ranking input needs the two-slice
 * walk-forward rule in docs/SCORING.md.
 */

const { isNumber, round } = require("./helpers");

const DEFAULT_SMC_SETTINGS = Object.freeze({
  swingLen: 3, // bars each side of a fractal swing
  obLookback: 20, // how far back to look for the order-block candle
  fvgMaxAge: 250, // drop unfilled gaps older than this many bars
  fvgMaxKeep: 40, // and never track more than this many per side
  sweepMemory: 20, // report a sweep for this many bars after it printed
});

/** True when bar j is a fractal high/low with `len` bars on both sides. */
function isSwing(candles, j, len, key, cmp) {
  const v = candles[j][key];
  if (!isNumber(v)) return false;
  for (let k = 1; k <= len; k++) {
    const l = candles[j - k][key];
    const r = candles[j + k][key];
    if (!isNumber(l) || !isNumber(r) || !cmp(v, l) || !cmp(v, r)) return false;
  }
  return true;
}

/** Last candle within `lookback` bars before `end` whose colour is `red` (close < open). */
function findOrderBlock(candles, end, lookback, red) {
  for (let j = end - 1; j >= Math.max(0, end - lookback); j--) {
    const c = candles[j];
    if (!isNumber(c.open) || !isNumber(c.close)) continue;
    if (red ? c.close < c.open : c.close > c.open) return { low: c.low, high: c.high, idx: j };
  }
  return null;
}

/** Nearest unfilled gap to `close` (by its edge facing price), or null. */
function nearestGap(gaps, close, edge) {
  let best = null;
  let bestDist = Infinity;
  for (const g of gaps) {
    const d = Math.abs(close - g[edge]);
    if (d < bestDist) {
      bestDist = d;
      best = g;
    }
  }
  return best;
}

/**
 * Returns an array aligned with `candles`; each element is the per-bar SMC
 * read (keys match the technical_analysis smc_* columns in camelCase).
 */
function smartMoney(candles, settings = {}) {
  const cfg = { ...DEFAULT_SMC_SETTINGS, ...settings };
  const L = cfg.swingLen;
  const n = candles.length;
  const out = new Array(n);

  let swingHigh = null; // { price, idx, broken }
  let swingLow = null;
  let structure = null;
  let lastEvent = null;
  let lastEventIdx = null;
  let bullOb = null;
  let bearOb = null;
  let bullGaps = [];
  let bearGaps = [];
  let lastSweep = null;
  let lastSweepIdx = null;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const close = c.close;

    // 1. Register swings that became known at this bar (formed at i - L).
    const j = i - L;
    if (j >= L) {
      if (isSwing(candles, j, L, "high", (a, b) => a > b)) swingHigh = { price: candles[j].high, idx: j, broken: false };
      if (isSwing(candles, j, L, "low", (a, b) => a < b)) swingLow = { price: candles[j].low, idx: j, broken: false };
    }

    // 2. New fair value gaps printed by this bar.
    if (i >= 2 && isNumber(c.low) && isNumber(c.high)) {
      const h2 = candles[i - 2].high;
      const l2 = candles[i - 2].low;
      if (isNumber(h2) && c.low > h2) bullGaps.push({ low: h2, high: c.low, idx: i });
      if (isNumber(l2) && c.high < l2) bearGaps.push({ low: c.high, high: l2, idx: i });
    }

    if (isNumber(close) && isNumber(c.high) && isNumber(c.low)) {
      // 3. Structure breaks (on close) and liquidity sweeps (wick only).
      if (swingHigh && !swingHigh.broken) {
        if (close > swingHigh.price) {
          lastEvent = structure === "BEARISH" ? "CHOCH_UP" : "BOS_UP";
          lastEventIdx = i;
          structure = "BULLISH";
          swingHigh.broken = true;
          bullOb = findOrderBlock(candles, i, cfg.obLookback, true);
        } else if (c.high > swingHigh.price) {
          lastSweep = "SWEEP_HIGH";
          lastSweepIdx = i;
        }
      }
      if (swingLow && !swingLow.broken) {
        if (close < swingLow.price) {
          lastEvent = structure === "BULLISH" ? "CHOCH_DOWN" : "BOS_DOWN";
          lastEventIdx = i;
          structure = "BEARISH";
          swingLow.broken = true;
          bearOb = findOrderBlock(candles, i, cfg.obLookback, false);
        } else if (c.low < swingLow.price) {
          lastSweep = "SWEEP_LOW";
          lastSweepIdx = i;
        }
      }

      // 4. Mitigate order blocks and fill gaps with this bar's range.
      if (bullOb && close < bullOb.low) bullOb = null;
      if (bearOb && close > bearOb.high) bearOb = null;
      bullGaps = bullGaps.filter((g) => c.low > g.low && i - g.idx <= cfg.fvgMaxAge).slice(-cfg.fvgMaxKeep);
      bearGaps = bearGaps.filter((g) => c.high < g.high && i - g.idx <= cfg.fvgMaxAge).slice(-cfg.fvgMaxKeep);
    }

    // 5. Per-bar read.
    const fvgBull = isNumber(close) ? nearestGap(bullGaps, close, "high") : null;
    const fvgBear = isNumber(close) ? nearestGap(bearGaps, close, "low") : null;
    let rangePos = null;
    if (swingHigh && swingLow && isNumber(close) && swingHigh.price > swingLow.price) {
      rangePos = round(((close - swingLow.price) / (swingHigh.price - swingLow.price)) * 100, 2);
    }
    let bias = null;
    if (structure && isNumber(rangePos)) {
      const discount = rangePos <= 50;
      bias = structure === "BULLISH" ? (discount ? "BULLISH_DISCOUNT" : "BULLISH_PREMIUM") : discount ? "BEARISH_DISCOUNT" : "BEARISH_PREMIUM";
    }
    const sweepFresh = lastSweepIdx !== null && i - lastSweepIdx <= cfg.sweepMemory;

    out[i] = {
      smcStructure: structure,
      smcLastEvent: lastEvent,
      smcEventBarsAgo: lastEventIdx === null ? null : i - lastEventIdx,
      smcBullObLow: bullOb ? round(bullOb.low, 6) : null,
      smcBullObHigh: bullOb ? round(bullOb.high, 6) : null,
      smcBearObLow: bearOb ? round(bearOb.low, 6) : null,
      smcBearObHigh: bearOb ? round(bearOb.high, 6) : null,
      smcFvgBullLow: fvgBull ? round(fvgBull.low, 6) : null,
      smcFvgBullHigh: fvgBull ? round(fvgBull.high, 6) : null,
      smcFvgBearLow: fvgBear ? round(fvgBear.low, 6) : null,
      smcFvgBearHigh: fvgBear ? round(fvgBear.high, 6) : null,
      smcSweep: sweepFresh ? lastSweep : null,
      smcSweepBarsAgo: sweepFresh ? i - lastSweepIdx : null,
      smcRangePosPct: rangePos,
      smcBias: bias,
    };
  }

  return out;
}

module.exports = {
  DEFAULT_SMC_SETTINGS,
  smartMoney,
};
