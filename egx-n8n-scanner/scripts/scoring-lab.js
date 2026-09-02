/**
 * scoring-lab.js — offline replay of workflow 11's ranking layer under
 * alternative scoring variants, evaluated against what actually happened.
 *
 * Why this exists: the 2026-08-24 calibration shipped on hit-rate alone and
 * had to be rolled back (it gamed the metric with trivially-close targets).
 * Any change to scoring must now be compared side-by-side on the SAME
 * historical inputs, on metrics that cannot be gamed by shrinking targets:
 *   - hit / stop / expired rate inside the estimated window (as workflow 16)
 *   - median potential gain to T1 (must not collapse)
 *   - realized return and realized R-multiple per pick
 *   - 10-session forward close-to-close return of the Top 10 (target-free)
 *
 * The scoring functions below are the same code that runs in workflow 11's
 * "Compute Overall Score & Trade Structure" node, parameterised so variants
 * can change ONE thing at a time. Sub-scores (breakout/momentum/pullback/
 * reversal/accumulation) are taken as stored — this replays the ranking
 * layer, not the scanners.
 *
 * Runs in two places:
 *   1. node scripts/scoring-lab.js            (self-test on synthetic data)
 *   2. pasted into the "Replay Variants" Code node of the ZZ Scoring Lab
 *      helper workflow, where `rows` = $('Inputs').all() and `candles` =
 *      $input.all() (see runLab at the bottom).
 */

// ---------------------------------------------------------------- helpers
function isNumber(v) { return typeof v === "number" && Number.isFinite(v); }
function safeDivide(n, d) {
  if (!isNumber(n) || !isNumber(d) || d === 0) return null;
  const r = n / d; return Number.isFinite(r) ? r : null;
}
function round(v, decimals = 4) {
  if (!isNumber(v)) return null;
  const f = Math.pow(10, decimals); return Math.round(v * f) / f;
}
function clamp(v, min, max) { if (!isNumber(v)) return min; return Math.min(Math.max(v, min), max); }
function num(v) { if (v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function median(arr) {
  const a = arr.filter(isNumber).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mean(arr) { const a = arr.filter(isNumber); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

// ----------------------------------------------------------- overallScore
const DEFAULT_WEIGHTS = {
  trend: 20, volume: 20, momentum: 15, breakout: 15, price_structure: 10,
  macd: 5, rsi: 5, relative_strength: 5, risk_reward: 5,
};
function safeFactor(v) { return isNumber(v) ? clamp(v, 0, 100) : 0; }
function calculateOverallScore(factors, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const weightSum = Object.values(w).reduce((a, b) => a + (isNumber(b) ? b : 0), 0) || 100;
  const c = {
    trend: safeFactor(factors.trend) * (w.trend / weightSum),
    volume: safeFactor(factors.volume) * (w.volume / weightSum),
    momentum: safeFactor(factors.momentum) * (w.momentum / weightSum),
    breakout: safeFactor(factors.breakout) * (w.breakout / weightSum),
    priceStructure: safeFactor(factors.priceStructure) * (w.price_structure / weightSum),
    macd: safeFactor(factors.macd) * (w.macd / weightSum),
    rsi: safeFactor(factors.rsi) * (w.rsi / weightSum),
    relativeStrength: safeFactor(factors.relativeStrength) * (w.relative_strength / weightSum),
    riskReward: safeFactor(factors.riskReward) * (w.risk_reward / weightSum),
  };
  return { overallScore: clamp(round(Object.values(c).reduce((a, b) => a + b, 0), 2), 0, 100), contributions: c };
}
function classifySetupType(subScores, { eligible = true, minScore = 55 } = {}) {
  if (!eligible) return "AVOID";
  const candidates = [
    { type: "BREAKOUT", score: subScores.breakoutScore },
    { type: "MOMENTUM", score: subScores.momentumScore },
    { type: "PULLBACK", score: subScores.pullbackScore },
    { type: "REVERSAL", score: subScores.reversalScore },
    { type: "ACCUMULATION", score: subScores.accumulationScore },
  ].filter((c) => isNumber(c.score));
  if (!candidates.length) return "NEUTRAL";
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].score >= minScore ? candidates[0].type : "NEUTRAL";
}
function calculateSetupConfidence(subScores) {
  const scores = [subScores.breakoutScore, subScores.momentumScore, subScores.pullbackScore,
    subScores.reversalScore, subScores.accumulationScore].filter(isNumber).sort((a, b) => b - a);
  if (!scores.length) return 0;
  const top = scores[0]; const runnerUp = scores[1] ?? 0;
  return round(clamp(top * 0.6 + Math.min(top - runnerUp, 40) * 1.0, 0, 100), 2);
}

// ------------------------------------------------------------- riskReward
// Parameterised copy of workflow 11's buildTradeStructure. Defaults are the
// production values; variants override `atrMultiples` / `stopAtrMult`.
function buildTradeStructure({ close, atr14, resistances = [], supports = [], setupType, minGainPct,
  atrMultiples = [1.5, 2.5, 3.5], stopAtrMult = 1.5 }) {
  if (!isNumber(close)) return emptyStructure();
  const [r1, r2, r3] = resistances; const [s1] = supports;
  const atr = isNumber(atr14) ? atr14 : null;
  let entry = null, invalidation = null;
  switch (setupType) {
    case "BREAKOUT":
      entry = isNumber(r1) ? r1 * 1.002 : close;
      invalidation = isNumber(s1) ? s1 : (atr ? close - atr * stopAtrMult : null);
      break;
    case "MOMENTUM":
      entry = close;
      invalidation = atr ? close - atr * stopAtrMult : (isNumber(s1) ? s1 : null);
      break;
    case "PULLBACK":
      entry = isNumber(s1) ? Math.max(s1, close) : close;
      invalidation = isNumber(s1) ? s1 * 0.985 : (atr ? close - atr * 1.2 : null);
      break;
    case "REVERSAL":
      entry = close;
      invalidation = isNumber(s1) ? s1 * 0.985 : (atr ? close - atr * 1.2 : null);
      break;
    default:
      entry = close;
      invalidation = atr ? close - atr * stopAtrMult : null;
  }
  const targets = deriveTargets({ entry: entry ?? close, atr, resistances: [r1, r2, r3], minGainPct, atrMultiples });
  const risk = isNumber(entry) && isNumber(invalidation) ? entry - invalidation : null;
  const withRR = targets.map((t) => ({
    target: t,
    riskReward: computeRiskReward(entry, invalidation, t),
    gainPct: calculateGainPct(entry, t),
    estimatedDays: estimateDaysToTarget(entry, t, atr),
  }));
  return {
    entry: round(entry, 6), invalidation: round(invalidation, 6),
    target1: round(withRR[0]?.target ?? null, 6), target2: round(withRR[1]?.target ?? null, 6), target3: round(withRR[2]?.target ?? null, 6),
    riskRewardT1: round(withRR[0]?.riskReward ?? null, 4),
    riskAmount: isNumber(risk) && risk > 0 ? round(risk, 6) : null,
    target1GainPct: round(withRR[0]?.gainPct ?? null, 4),
    target1EstimatedDays: withRR[0]?.estimatedDays ?? null,
    t1FromResistance: isNumber(withRR[0]?.target) && [r1, r2, r3].some((r) => isNumber(r) && Math.abs(r - withRR[0].target) < 1e-9),
  };
}
function calculateGainPct(entry, target) {
  if (!isNumber(entry) || !isNumber(target) || entry <= 0) return null;
  return ((target - entry) / entry) * 100;
}
function estimateDaysToTarget(entry, target, atr14) {
  if (!isNumber(entry) || !isNumber(target) || !isNumber(atr14) || atr14 <= 0) return null;
  const distance = target - entry; if (distance <= 0) return null;
  return Math.max(1, Math.ceil(distance / (atr14 * 0.5) - 1e-9));
}
function deriveTargets({ entry, atr, resistances, minGainPct, atrMultiples }) {
  const floor = isNumber(minGainPct) && minGainPct > 0 ? entry * (1 + minGainPct / 100) : entry;
  const candidates = resistances.filter((r) => isNumber(r) && r > entry && r >= floor);
  const atrTargets = isNumber(atr) ? atrMultiples.map((m) => entry + atr * m).filter((t) => t > entry && t >= floor) : [];
  const targets = []; let atrIdx = 0; let prev = null;
  for (let i = 0; i < 3; i++) {
    let next = null;
    if (candidates[i] !== undefined && (prev === null || candidates[i] > prev)) next = candidates[i];
    else {
      while (atrIdx < atrTargets.length && prev !== null && atrTargets[atrIdx] <= prev) atrIdx++;
      if (atrIdx < atrTargets.length) next = atrTargets[atrIdx++];
    }
    targets.push(next); if (next !== null) prev = next;
  }
  return targets;
}
function computeRiskReward(entry, invalidation, target) {
  if (!isNumber(entry) || !isNumber(invalidation) || !isNumber(target)) return null;
  const risk = entry - invalidation; if (risk <= 0) return null;
  return safeDivide(target - entry, risk);
}
function emptyStructure() {
  return { entry: null, invalidation: null, target1: null, target2: null, target3: null, riskRewardT1: null,
    riskAmount: null, target1GainPct: null, target1EstimatedDays: null, t1FromResistance: false };
}

// -------------------------------------------------------------- variants
// Each variant changes the ranking layer in ONE documented way (or is a
// named bundle of previously-tested single changes). `market` config comes
// from the `markets` row. Options:
//   profile          'default' | 'candidate'  (candidate = workflow 11's applyCandidateProfile,
//                                             with P(T1) estimated WALK-FORWARD, never from the future)
//   rrWeight         risk_reward weight override (production 5)
//   minRR            exclude picks whose R:R to T1 is below this from the Top-N
//   atrMultiples     ATR fallback target rungs (production [1.5, 2.5, 3.5])
//   stopAtrMult      ATR stop multiple for MOMENTUM/default (production 1.5)
//   accumOverext     apply momentum-style overextension/overbought penalty to accumulation sub-score
//   excludeSetups    setup types excluded from the Top-N entirely
//   requireTarget    exclude picks with no T1 (untradeable) from the Top-N
//   weights          partial override of DEFAULT_WEIGHTS
//   usRsiPenalty / estDaysPenalty / probBlend   the three candidate corrections, individually
//   rsiPenalty       { above, perPoint, max } overbought penalty for any market
//   setupPenalty     { SETUP: +/-points } flat adjustment by setup type
//   rsVsMarket       relative_strength factor from the 20d return MINUS the same-day
//                    market median (what workflow 11 stores as relative_strength_20d)
//   rsSlope          factor points per percentage point of RS input (production 3)
//   eqBlend          blend Entry Quality (code/entryQuality.js) into the score, 0..1
//   stopAtrMult      defaults to cfg.atrStopMult (production, per market) when unset
const VARIANTS = [
  { key: "V0_default", profile: "default" },
  { key: "V1_candidate", profile: "candidate" },
  { key: "V2_requireTarget", profile: "default", requireTarget: true },
  { key: "V3_minRR_1.0", profile: "default", requireTarget: true, minRR: 1.0 },
  { key: "V4_minRR_1.5", profile: "default", requireTarget: true, minRR: 1.5 },
  { key: "V5_rrWeight15", profile: "default", requireTarget: true, rrWeight: 15 },
  { key: "V6_atr2-3-4", profile: "default", requireTarget: true, atrMultiples: [2.0, 3.0, 4.0] },
  { key: "V7_accumOverext", profile: "default", requireTarget: true, accumOverext: true },
  { key: "V8_noBreakout", profile: "default", requireTarget: true, excludeSetups: ["BREAKOUT"] },
  { key: "V9_cand_minRR1", profile: "candidate", requireTarget: true, minRR: 1.0 },
  // Tier 1 (2026-09-02): market-relative RS and Entry Quality as ranking inputs.
  // Verdict (both markets, BACKTEST+LIVE, see docs/SCORING.md): V10-V12 neutral
  // within noise; V13-V15 worse on LIVE for both markets (EGX also worse on
  // BACKTEST). None shipped — both stay display-only columns.
  { key: "V10_rsVsMarket", profile: "default", rsVsMarket: true },
  { key: "V11_rsVsMkt_w10", profile: "default", rsVsMarket: true, weights: { relative_strength: 10 } },
  { key: "V12_rsVsMkt_s5", profile: "default", rsVsMarket: true, rsSlope: 5 },
  { key: "V13_eqBlend10", profile: "default", eqBlend: 0.1 },
  { key: "V14_eqBlend20", profile: "default", eqBlend: 0.2 },
  { key: "V15_rsVsMkt_eq10", profile: "default", rsVsMarket: true, eqBlend: 0.1 },
];

// Entry Quality — same arithmetic as code/entryQuality.js (extension 40 /
// close position 30 / RSI 3-session slope 30; missing inputs sit at midpoint).
function entryQualityScore(row) {
  const close = row.close;
  let ext = 20;
  if (isNumber(close) && isNumber(row.ema20) && isNumber(row.atr14) && row.atr14 > 0) {
    const e = (close - row.ema20) / row.atr14;
    ext = e >= -0.5 && e <= 1.0 ? 40 : e > 1.0 ? clamp(40 * (1 - (e - 1.0) / 2.0), 0, 40) : clamp(40 * (1 - (-0.5 - e) / 1.5), 0, 40);
  }
  let pos = 15;
  if (isNumber(close) && isNumber(row.high) && isNumber(row.low)) {
    const range = row.high - row.low;
    pos = (range > 0 ? clamp((close - row.low) / range, 0, 1) : 0.5) * 30;
  }
  let slope = 15;
  if (isNumber(row.rsi14) && isNumber(row.rsi14_3d_ago)) slope = clamp(15 + (row.rsi14 - row.rsi14_3d_ago) * 1.5, 0, 30);
  return clamp(round(ext + pos + slope, 2), 0, 100);
}

function scoreRow(row, cfg, v, probs, ctx = {}) {
  const close = row.close;
  if (!isNumber(close)) return { eligible: false, rankable: false, setupType: "AVOID", score: 0, structure: emptyStructure() };
  let eligible = true;
  if (!isNumber(row.avg_traded_value20) || row.avg_traded_value20 < cfg.minAvgTradedValue) eligible = false;
  if (!isNumber(row.avg_volume20) || row.avg_volume20 < cfg.minAvgVolume) eligible = false;
  if (!isNumber(row.active_days20) || row.active_days20 < cfg.minActiveDays20) eligible = false;

  const trendMap = { STRONG_BULLISH: 100, BULLISH: 75, NEUTRAL: 50, BEARISH: 25, STRONG_BEARISH: 0 };
  const trendFactor = trendMap[row.medium_term_trend] ?? 50;
  const volumeFactor = isNumber(row.relative_volume20) ? clamp((row.relative_volume20 / 3) * 100, 0, 100) : 0;
  const macdFactor = isNumber(row.macd_histogram) ? clamp(50 + row.macd_histogram * 200, 0, 100) : 50;
  const rsiFactor = isNumber(row.momentum_score) ? row.momentum_score : 50;
  const priceStructureFactor = isNumber(row.nearest_resistance_distance_pct)
    ? clamp(100 - Math.min(100, row.nearest_resistance_distance_pct * 10), 0, 100) : 50;
  const return20d = isNumber(row.close20d_ago) && row.close20d_ago > 0 ? ((close - row.close20d_ago) / row.close20d_ago) * 100 : null;
  // Production: ABSOLUTE 20d return. rsVsMarket: minus the same-day median
  // 20d return of the market's universe (ctx.marketReturn20d, what workflow
  // 11 now stores as relative_strength_20d). rsSlope: points per pp (prod 3).
  const rsInput = v.rsVsMarket && isNumber(return20d) && isNumber(ctx.marketReturn20d) ? return20d - ctx.marketReturn20d : return20d;
  const rsSlope = isNumber(v.rsSlope) ? v.rsSlope : 3;
  const relativeStrengthFactor = isNumber(rsInput) ? clamp(50 + rsInput * rsSlope, 0, 100) : 50;

  let accumulation = row.accumulation_score || 0;
  if (v.accumOverext) {
    if (isNumber(row.ema20) && isNumber(row.atr14) && row.atr14 > 0) {
      const d = (close - row.ema20) / row.atr14;
      if (d > 2.5) accumulation = clamp(accumulation - Math.min(20, (d - 2.5) * 8), 0, 100);
    }
    if (isNumber(row.rsi14) && row.rsi14 > 75) accumulation = clamp(accumulation - Math.min(15, (row.rsi14 - 75) * 1.5), 0, 100);
  }
  const subScores = {
    breakoutScore: row.breakout_score || 0, momentumScore: row.momentum_score || 0,
    pullbackScore: row.pullback_score || 0, reversalScore: row.reversal_score || 0, accumulationScore: accumulation,
  };
  const setupType = classifySetupType(subScores, { eligible });
  const setupConfidence = calculateSetupConfidence(subScores);
  // Production stop multiple comes from markets.atr_stop_mult (EGX 2.0 / US
  // 1.5 since 2026-09-02) and the ATR target ladder is (m, m+1, m+2) x ATR.
  const stopAtrMult = isNumber(v.stopAtrMult) ? v.stopAtrMult : (isNumber(cfg.atrStopMult) ? cfg.atrStopMult : 1.5);
  const structure = buildTradeStructure({
    close, atr14: row.atr14,
    resistances: [row.resistance1, row.resistance2, row.resistance3],
    supports: [row.support1, row.support2, row.support3],
    setupType, minGainPct: cfg.minTargetGainPct,
    atrMultiples: v.atrMultiples || [stopAtrMult, stopAtrMult + 1, stopAtrMult + 2], stopAtrMult,
  });
  const riskRewardFactor = isNumber(structure.riskRewardT1) ? clamp(structure.riskRewardT1 * 30, 0, 100) : 0;
  const weights = { ...DEFAULT_WEIGHTS, ...(v.weights || {}) };
  if (isNumber(v.rrWeight)) weights.risk_reward = v.rrWeight;
  let { overallScore } = calculateOverallScore({
    trend: trendFactor, volume: volumeFactor, momentum: subScores.momentumScore, breakout: subScores.breakoutScore,
    priceStructure: priceStructureFactor, macd: macdFactor, rsi: rsiFactor, relativeStrength: relativeStrengthFactor,
    riskReward: riskRewardFactor,
  }, weights);

  // Post-blend adjustments. 'candidate' is workflow 11's applyCandidateProfile
  // (all three corrections); the individual flags let each be tested alone.
  const cand = v.profile === "candidate";
  const usRsiPenalty = cand || v.usRsiPenalty;
  const estDaysPenalty = cand || v.estDaysPenalty;
  const probBlend = cand ? 0.2 : (isNumber(v.probBlend) ? v.probBlend : 0);
  const eqBlend = isNumber(v.eqBlend) ? v.eqBlend : 0;
  if (usRsiPenalty || estDaysPenalty || probBlend > 0 || eqBlend > 0 || v.setupPenalty || v.rsiPenalty) {
    let s = overallScore;
    // Entry Quality (code/entryQuality.js, stored as entry_quality_score) blended
    // into the setup score: eqBlend = 0.1 means 90% setup / 10% entry timing.
    if (eqBlend > 0) {
      const eq = entryQualityScore(row);
      if (isNumber(eq)) s = s * (1 - eqBlend) + eq * eqBlend;
    }
    if (usRsiPenalty && cfg.market === "US" && isNumber(row.rsi14) && row.rsi14 > 70) s -= Math.min((row.rsi14 - 70) * 0.8, 16);
    // market-agnostic overbought penalty: rsiPenalty = { above: 70, perPoint: 0.8, max: 16 }
    if (v.rsiPenalty && isNumber(row.rsi14) && row.rsi14 > v.rsiPenalty.above) {
      s -= Math.min((row.rsi14 - v.rsiPenalty.above) * v.rsiPenalty.perPoint, v.rsiPenalty.max);
    }
    const est = structure.target1EstimatedDays;
    if (estDaysPenalty && isNumber(est) && est > 3) s -= Math.min((est - 3) * 4, 8);
    // flat additive adjustment per setup type, e.g. { MOMENTUM: -5, ACCUMULATION: +3 }
    if (v.setupPenalty && isNumber(v.setupPenalty[setupType])) s += v.setupPenalty[setupType];
    const p = probs ? probs[setupType] : null;
    if (probBlend > 0 && isNumber(p)) s = s * (1 - probBlend) + p * probBlend;
    overallScore = clamp(round(s, 2), 0, 100);
  }

  let rankable = eligible;
  if (v.requireTarget && !isNumber(structure.target1)) rankable = false;
  if (isNumber(v.minRR) && (!isNumber(structure.riskRewardT1) || structure.riskRewardT1 < v.minRR)) rankable = false;
  if (Array.isArray(v.excludeSetups) && v.excludeSetups.includes(setupType)) rankable = false;
  return { eligible, rankable, setupType, setupConfidence, score: overallScore, structure };
}

// ------------------------------------------------------------- outcomes
// Mirrors workflow 16's Compute Window Outcome exactly, plus target-free
// forward returns. `fwd` = candles strictly after the scan date, ascending.
function evaluate(pick, fwd) {
  const st = pick.structure;
  const out = { outcome: "UNEVALUABLE", resolvedDay: null, realizedPct: null, realizedR: null, fwd5: null, fwd10: null };
  if (fwd.length >= 5 && isNumber(pick.close)) out.fwd5 = ((fwd[4].close - pick.close) / pick.close) * 100;
  if (fwd.length >= 10 && isNumber(pick.close)) out.fwd10 = ((fwd[9].close - pick.close) / pick.close) * 100;
  const est = st.target1EstimatedDays, t1 = st.target1, inv = st.invalidation, entry = st.entry;
  if (!isNumber(est) || !isNumber(t1) || !isNumber(inv) || !isNumber(entry) || est < 1) return out;
  const w = fwd.slice(0, est);
  for (let d = 0; d < w.length; d++) {
    const hitT = isNumber(w[d].high) && w[d].high >= t1;
    const hitS = isNumber(w[d].low) && w[d].low <= inv;
    if (hitT || hitS) {
      out.outcome = hitS ? "STOP_HIT" : "TARGET1_HIT"; out.resolvedDay = d + 1; break;
    }
  }
  if (out.outcome === "UNEVALUABLE") {
    if (w.length >= est) out.outcome = "EXPIRED_NO_HIT"; else { out.outcome = "PENDING"; return out; }
  }
  const risk = entry - inv;
  if (out.outcome === "TARGET1_HIT") { out.realizedPct = ((t1 - entry) / entry) * 100; out.realizedR = risk > 0 ? (t1 - entry) / risk : null; }
  else if (out.outcome === "STOP_HIT") { out.realizedPct = ((inv - entry) / entry) * 100; out.realizedR = -1; }
  else { const c = w[w.length - 1].close; out.realizedPct = ((c - entry) / entry) * 100; out.realizedR = risk > 0 ? (c - entry) / risk : null; }
  return out;
}

function summarize(picks) {
  const ev = picks.filter((p) => ["TARGET1_HIT", "STOP_HIT", "EXPIRED_NO_HIT"].includes(p.ev.outcome));
  const n = ev.length;
  const pct = (k) => n ? round(100 * ev.filter((p) => p.ev.outcome === k).length / n, 1) : null;
  const f10 = picks.map((p) => p.ev.fwd10).filter(isNumber);
  return {
    picks: picks.length, evaluated: n,
    unevaluable: picks.filter((p) => p.ev.outcome === "UNEVALUABLE").length,
    pending: picks.filter((p) => p.ev.outcome === "PENDING").length,
    hit: pct("TARGET1_HIT"), stop: pct("STOP_HIT"), expired: pct("EXPIRED_NO_HIT"),
    medGainT1: round(median(ev.map((p) => p.structure.target1GainPct)), 2),
    medRR: round(median(ev.map((p) => p.structure.riskRewardT1)), 2),
    medEstDays: median(ev.map((p) => p.structure.target1EstimatedDays)),
    meanRealPct: round(mean(ev.map((p) => p.ev.realizedPct)), 2),
    medRealPct: round(median(ev.map((p) => p.ev.realizedPct)), 2),
    expR: round(mean(ev.map((p) => p.ev.realizedR)), 3),
    fwd10n: f10.length, fwd10mean: round(mean(f10), 2), fwd10med: round(median(f10), 2),
    fwd10pos: f10.length ? round(100 * f10.filter((x) => x > 0).length / f10.length, 1) : null,
    fwd5mean: round(mean(picks.map((p) => p.ev.fwd5)), 2),
  };
}

// ---------------------------------------------------------------- runner
function runLab(rows, candles, { market, cfg, topN = 10, variants = VARIANTS, probMinSample = 30, probLagDays = 12 }) {
  // Normalise numerics (n8n's Postgres node returns NUMERIC as strings).
  const numCols = ["close", "avg_volume20", "avg_traded_value20", "active_days20", "close20d_ago", "atr14", "data_confidence",
    "macd_histogram", "relative_volume20", "rsi14", "ema20", "resistance1", "resistance2", "resistance3", "support1", "support2",
    "support3", "nearest_resistance_distance_pct", "nearest_support_distance_pct", "accumulation_score", "breakout_score",
    "momentum_score", "pullback_score", "reversal_score", "stored_score", "stored_rank", "high", "low", "rsi14_3d_ago"];
  for (const r of rows) for (const c of numCols) r[c] = num(r[c]);

  // Same-day market benchmark for rsVsMarket: median 20d return across every
  // row of the date (workflow 11 computes it over the same batch).
  const ret20 = (r) => isNumber(r.close) && isNumber(r.close20d_ago) && r.close20d_ago > 0 ? ((r.close - r.close20d_ago) / r.close20d_ago) * 100 : null;
  const marketRetByDate = new Map();
  for (const r of rows) { if (!marketRetByDate.has(r.d)) marketRetByDate.set(r.d, []); marketRetByDate.get(r.d).push(ret20(r)); }
  for (const [d, arr] of marketRetByDate) marketRetByDate.set(d, median(arr));
  const ctxFor = (d) => ({ marketReturn20d: marketRetByDate.get(d) ?? null });

  // Forward-candle index: stock_id -> ascending candles.
  const byStock = new Map();
  for (const c of candles) {
    const sid = String(c.stock_id);
    if (!byStock.has(sid)) byStock.set(sid, []);
    byStock.get(sid).push({ d: c.d, high: num(c.high), low: num(c.low), close: num(c.close) });
  }
  for (const arr of byStock.values()) arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const forward = (sid, d) => { const arr = byStock.get(String(sid)) || []; let i = 0; while (i < arr.length && arr[i].d <= d) i++; return arr.slice(i, i + 45); };

  const dates = [...new Set(rows.map((r) => r.d))].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const byDate = new Map(dates.map((d) => [d, []]));
  for (const r of rows) byDate.get(r.d).push(r);

  const report = { market, dates: dates.length, rows: rows.length, variants: {} };

  for (const v of variants) {
    // Pass 1: score + evaluate every row (needed for walk-forward P(T1)).
    const scored = [];
    const resolvedBySetup = new Map(); // setup -> [{dateIdx, hit}]
    for (const d of dates) {
      for (const r of byDate.get(d)) {
        const s = scoreRow(r, cfg, { ...v, profile: "default" }, null, ctxFor(d));
        const ev = evaluate({ structure: s.structure, close: r.close }, forward(r.stock_id, d));
        const rec = { d, di: dateIdx.get(d), stock_id: r.stock_id, symbol: r.symbol, run_type: r.run_type, close: r.close, row: r, ...s, ev };
        scored.push(rec);
        if (s.eligible && ["TARGET1_HIT", "STOP_HIT", "EXPIRED_NO_HIT"].includes(ev.outcome)) {
          if (!resolvedBySetup.has(s.setupType)) resolvedBySetup.set(s.setupType, []);
          resolvedBySetup.get(s.setupType).push({ di: rec.di, hit: ev.outcome === "TARGET1_HIT" ? 1 : 0 });
        }
      }
    }
    // Pass 2: (candidate only) re-score with walk-forward probabilities, then rank per date.
    const picks = [];
    const liveMatch = { n: 0, exact: 0, absDiffSum: 0 };
    for (const d of dates) {
      const di = dateIdx.get(d);
      let probs = null;
      const needsProbs = v.profile === "candidate" || (isNumber(v.probBlend) && v.probBlend > 0);
      if (needsProbs) {
        probs = {};
        for (const [setup, arr] of resolvedBySetup) {
          const prior = arr.filter((x) => x.di <= di - probLagDays);
          probs[setup] = prior.length >= probMinSample ? (100 * prior.reduce((s, x) => s + x.hit, 0) / prior.length) : null;
        }
      }
      const rescoring = needsProbs || v.usRsiPenalty || v.estDaysPenalty || v.setupPenalty || v.rsiPenalty;
      const dayRecs = scored.filter((x) => x.d === d).map((x) => {
        if (!rescoring) return x;
        const s = scoreRow(x.row, cfg, v, probs, ctxFor(d));
        return { ...x, ...s, ev: x.ev };
      });
      if (v.key === "V0_default") {
        for (const x of dayRecs) if (x.run_type === "LIVE" && isNumber(x.row.stored_score) && x.eligible) {
          liveMatch.n++; const diff = Math.abs(x.score - x.row.stored_score); liveMatch.absDiffSum += diff; if (diff < 0.005) liveMatch.exact++;
        }
      }
      const ranked = dayRecs.filter((x) => x.rankable)
        .sort((a, b) => b.score - a.score || (b.setupConfidence ?? 0) - (a.setupConfidence ?? 0) || (a.stock_id > b.stock_id ? 1 : -1))
        .slice(0, topN);
      ranked.forEach((x, i) => picks.push({ ...x, rank: i + 1 }));
    }
    const bySetup = {}; const byRun = {};
    for (const p of picks) { (bySetup[p.setupType] ||= []).push(p); (byRun[p.run_type] ||= []).push(p); }
    const vr = { options: { ...v }, all: summarize(picks), byRunType: {}, bySetup: {} };
    for (const k of Object.keys(byRun)) vr.byRunType[k] = summarize(byRun[k]);
    for (const k of Object.keys(bySetup)) vr.bySetup[k] = summarize(bySetup[k]);
    vr.setupMix = Object.fromEntries(Object.entries(bySetup).map(([k, a]) => [k, a.length]));
    if (v.key === "V0_default") vr.liveScoreMatch = { compared: liveMatch.n, exact: liveMatch.exact, meanAbsDiff: liveMatch.n ? round(liveMatch.absDiffSum / liveMatch.n, 3) : null };
    report.variants[v.key] = vr;
  }
  return report;
}

// ------------------------------------------------------------ self-test
if (typeof module !== "undefined" && require.main === module) {
  const rows = []; const candles = [];
  const dates = Array.from({ length: 40 }, (_, i) => `2026-06-${String(1 + (i % 28)).padStart(2, "0")}${i >= 28 ? "b" : ""}`).sort();
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let s = 1; s <= 30; s++) {
    let px = 10 + rnd() * 50;
    for (let i = 0; i < dates.length; i++) {
      px *= 1 + (rnd() - 0.48) * 0.04;
      const atr = px * 0.02;
      candles.push({ stock_id: s, d: dates[i], high: px * 1.015, low: px * 0.985, close: px });
      rows.push({ d: dates[i], run_type: i < 30 ? "BACKTEST" : "LIVE", stock_id: s, symbol: "S" + s, close: px,
        avg_volume20: 1e6, avg_traded_value20: 1e7, active_days20: 20, close20d_ago: px * (1 - (rnd() - 0.5) * 0.1),
        atr14: atr, macd_histogram: (rnd() - 0.5) * 0.2, relative_volume20: 0.5 + rnd() * 2, medium_term_trend: "BULLISH",
        rsi14: 30 + rnd() * 50, rsi14_3d_ago: 30 + rnd() * 50, ema20: px * (1 - (rnd() - 0.5) * 0.05),
        high: px * 1.015, low: px * 0.985,
        resistance1: px * (1 + rnd() * 0.05), resistance2: px * 1.08, resistance3: px * 1.12,
        support1: px * (1 - rnd() * 0.04), support2: px * 0.92, support3: px * 0.88,
        nearest_resistance_distance_pct: rnd() * 5, nearest_support_distance_pct: rnd() * 4,
        accumulation_score: rnd() * 100, breakout_score: rnd() * 100, momentum_score: rnd() * 100,
        pullback_score: rnd() * 60, reversal_score: rnd() * 60, stored_score: null, stored_rank: null });
    }
  }
  const cfg = { market: "EGX", minAvgTradedValue: 500000, minAvgVolume: 50000, minActiveDays20: 15, minTargetGainPct: 2, atrStopMult: 2.0 };
  const rep = runLab(rows, candles, { market: "EGX", cfg });
  const v0 = rep.variants.V0_default.all;
  if (!(v0.picks > 0 && isNumber(v0.hit) && v0.hit + v0.stop + v0.expired > 99)) { console.error("self-test failed", v0); process.exit(1); }
  for (const [k, v] of Object.entries(rep.variants)) console.log(k.padEnd(18), JSON.stringify(v.all));
  console.log("self-test ok");
}

// n8n Code node entry point (the tail is what the helper workflow appends):
//   const params = $('Params').first().json;
//   return [{ json: runLab($('Inputs').all().map(i => i.json), $input.all().map(i => i.json), params) }];
if (typeof module !== "undefined") module.exports = { runLab, VARIANTS, scoreRow, evaluate, buildTradeStructure };
