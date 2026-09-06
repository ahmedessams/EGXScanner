/**
 * Price-discontinuity flag — a DATA-QUALITY tell, not a ranking input.
 *
 * Pure functions over an ascending candle array; no I/O, no n8n globals.
 * Embedded into the "Calculate Indicators" Code node of
 * workflows/04-egx-technical-analysis.json after helpers.js (drop the
 * `require` line and the `module.exports` block when pasting).
 *
 * Motivation (2026-09-06): the gap-through backfill in workflow 16 surfaced
 * outliers like an EGX stop "gapped" −99.6% and a US target "gapped" +378%.
 * Those are provider glitches of the SEIGA type (0.95 ↔ 228.51 prints), not
 * real gaps — and every rolling indicator (high252, ATR, Ichimoku spans,
 * drift/vol, S/R levels) computed across such a print is poisoned for up to
 * 252 sessions afterwards.
 *
 * Definition: bar i is a discontinuity when close[i] / close[i-1] is at least
 * `ratio` (default 3×) or at most 1/ratio. A single bad print therefore shows
 * up TWICE (the jump and the return). Genuine one-day moves of 3× do not
 * happen on EGX (±10–20% limits) and are extraordinary for the S&P-sized US
 * universe; an unadjusted split would also trip it, which is equally worth a
 * warning because the indicators are wrong across it either way.
 *
 * NOT folded into `data_confidence` — that column is a scoring input and the
 * two-slice walk-forward rule (docs/SCORING.md) applies to any ranking change.
 */

const { isNumber, round } = require("./helpers");

const DEFAULT_DISCONTINUITY_SETTINGS = Object.freeze({
  ratio: 3, // close/prevClose beyond 3× or below 1/3
  lookback: 252, // sessions the count covers (one trading year)
});

/**
 * Returns arrays aligned with `candles` (ascending):
 *   count[i]    number of discontinuities in the last `lookback` bars ending at i
 *   lastDate[i] date of the most recent one inside that window (null if none)
 *   lastPct[i]  its close-to-close change in % (e.g. +23954.7 for 0.95→228.51)
 */
function priceDiscontinuities(candles, settings = {}) {
  const cfg = { ...DEFAULT_DISCONTINUITY_SETTINGS, ...settings };
  const ratio = cfg.ratio > 1 ? cfg.ratio : DEFAULT_DISCONTINUITY_SETTINGS.ratio;
  const lookback = cfg.lookback > 0 ? cfg.lookback : DEFAULT_DISCONTINUITY_SETTINGS.lookback;
  const n = candles.length;

  const isBreak = new Array(n).fill(false);
  const jumpPct = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    if (!isNumber(prev) || !isNumber(cur) || prev <= 0 || cur <= 0) continue;
    const r = cur / prev;
    if (r >= ratio || r <= 1 / ratio) {
      isBreak[i] = true;
      jumpPct[i] = round((r - 1) * 100, 2);
    }
  }

  const count = new Array(n).fill(0);
  const lastDate = new Array(n).fill(null);
  const lastPct = new Array(n).fill(null);
  let running = 0;
  for (let i = 0; i < n; i++) {
    if (isBreak[i]) running += 1;
    if (i - lookback >= 0 && isBreak[i - lookback]) running -= 1;
    count[i] = running;
    if (running === 0) continue;
    if (isBreak[i]) {
      lastDate[i] = candles[i].date;
      lastPct[i] = jumpPct[i];
    } else {
      lastDate[i] = lastDate[i - 1];
      lastPct[i] = lastPct[i - 1];
    }
  }

  return { isBreak, count, lastDate, lastPct };
}

module.exports = {
  DEFAULT_DISCONTINUITY_SETTINGS,
  priceDiscontinuities,
};
