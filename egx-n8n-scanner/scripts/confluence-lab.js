/**
 * confluence-lab.js — Phase 2 of docs/SWAP-ENGINE-PLAN.md.
 *
 * Runs inside an n8n Code node (runOnceForAllItems) fed by
 *   SELECT market, slice, bits, outcome, realized_mtm, extension_atr,
 *          relative_volume20, market_score
 *   FROM lab_features WHERE outcome IS NOT NULL AND overall_rank <= 10
 * and by lab_feature_names (idx, name). Pure JS, no I/O: the same file can
 * be run under plain node with a rows array for testing.
 *
 * Method: literals = every feature and its complement (2 x 97). Cells =
 * conjunctions of 1, 2 or 3 literals. A cell is scored on TRAIN (backtest
 * < 2025) by its mean realized return (mark-to-market) and by its LIFT over
 * two baselines: (a) the unconditional Top-10 mean, (b) the mean the pick's
 * own extension x RVOL x market-score context cell would predict (the
 * probability_context_stats grid). A cell counts as REPLICATED only if
 * lift_b is positive on TRAIN (n >= 200, t >= 2.5), positive on HOLDOUT
 * (backtest >= 2025, n >= 50) and not contradicted by LIVE (n >= 15 with
 * negative lift_b fails; smaller LIVE samples are "untested"). Negative
 * cells (avoid-states) are replicated symmetrically.
 * INCREMENTAL rule: a pair must beat the better of its two single literals,
 * a triple the best of its three pairs, on TRAIN (by >= INCR_MIN points) and
 * on HOLDOUT (same sign) — otherwise it is just a sub-population of a
 * simpler cell and adds nothing.
 */

const MIN_TRAIN = 200, MIN_HOLDOUT = 50, MIN_LIVE = 15, T_MIN = 2.5, TOP_PAIRS = 300, TOP_TRIPLES = 200, INCR_MIN = 0.2;

function extBucket(e) { return e === null ? 6 : e < 0 ? 0 : e < 1 ? 1 : e < 2 ? 2 : e < 3 ? 3 : e < 4 ? 4 : 5; }
function rvolBucket(v) { return v === null ? 3 : v < 1 ? 0 : v < 2.5 ? 1 : 2; }
function msBucket(m) { return m === null ? 3 : m < 40 ? 0 : m < 60 ? 1 : 2; }

function prepare(rows) {
  const out = [];
  for (const r of rows) {
    const y = Number(r.realized_mtm);
    if (!Number.isFinite(y) || typeof r.bits !== 'string') continue;
    const bits = new Uint8Array(r.bits.length);
    for (let i = 0; i < r.bits.length; i++) bits[i] = r.bits.charCodeAt(i) === 49 ? 1 : 0;
    const num = (v) => (v === null || v === undefined || v === '') ? null : Number(v);
    out.push({ market: r.market, slice: r.slice, bits, y, hit: r.outcome === 'TARGET1_HIT' ? 1 : 0,
      cell: extBucket(num(r.extension_atr)) * 16 + rvolBucket(num(r.relative_volume20)) * 4 + msBucket(num(r.market_score)) });
  }
  return out;
}

/** literal = { f, v }: feature index f must equal v (1 = feature, 0 = complement). */
function matches(row, lits) {
  for (const l of lits) if (row.bits[l.f] !== l.v) return false;
  return true;
}

function stats(rowsInSlice, lits, cellMean) {
  let n = 0, s = 0, s2 = 0, hits = 0, base = 0;
  for (const r of rowsInSlice) {
    if (!matches(r, lits)) continue;
    n++; s += r.y; s2 += r.y * r.y; hits += r.hit; base += cellMean[r.cell] ?? 0;
  }
  if (!n) return { n: 0 };
  const mean = s / n, sd = Math.sqrt(Math.max(s2 / n - mean * mean, 1e-9));
  const liftB = mean - base / n;
  return { n, mean, hit: hits / n, liftB, t: liftB / (sd / Math.sqrt(n)) };
}

function litName(names, l) { return (l.v ? '' : 'NOT ') + (names[l.f] || ('f' + l.f)); }

function runMarket(all, names, market) {
  const rows = all.filter((r) => r.market === market);
  const train = rows.filter((r) => r.slice === 'TRAIN'), hold = rows.filter((r) => r.slice === 'HOLDOUT'), live = rows.filter((r) => r.slice === 'LIVE');
  const nF = rows.length ? rows[0].bits.length : 0;
  // baseline (b): context-cell means learned on TRAIN only
  const cellSum = {}, cellN = {};
  for (const r of train) { cellSum[r.cell] = (cellSum[r.cell] || 0) + r.y; cellN[r.cell] = (cellN[r.cell] || 0) + 1; }
  const cellMean = {}; for (const k in cellN) cellMean[k] = cellSum[k] / cellN[k];
  const uncond = (arr) => arr.length ? arr.reduce((a, r) => a + r.y, 0) / arr.length : null;
  const baseline = { train: { n: train.length, mean: uncond(train) }, holdout: { n: hold.length, mean: uncond(hold) }, live: { n: live.length, mean: uncond(live) } };

  const literals = [];
  for (let f = 0; f < nF; f++) literals.push({ f, v: 1 }, { f, v: 0 });

  // cached sub-cell means (train / holdout) for the incremental rule
  const key = (lits) => lits.map((x) => x.f * 2 + x.v).sort((a, b) => a - b).join(',');
  const cacheTr = new Map(), cacheHo = new Map();
  function meanOf(cache, rowsIn, lits) {
    const k = key(lits); if (cache.has(k)) return cache.get(k);
    const st = stats(rowsIn, lits, cellMean); const m = st.n ? st.mean : null; cache.set(k, m); return m;
  }
  function bestParent(cache, rowsIn, lits, sign) {
    if (lits.length < 2) return null;
    let best = null;
    for (let i = 0; i < lits.length; i++) {
      const m = meanOf(cache, rowsIn, lits.filter((_, j) => j !== i));
      if (m === null) continue;
      if (best === null || (sign > 0 ? m > best : m < best)) best = m;
    }
    return best;
  }
  function evaluate(lits) {
    const tr = stats(train, lits, cellMean);
    if (tr.n < MIN_TRAIN || Math.abs(tr.t) < T_MIN) return null;
    const sign = Math.sign(tr.liftB);
    const pTr = bestParent(cacheTr, train, lits, sign);
    const incrTr = pTr === null ? null : sign * (tr.mean - pTr);
    if (incrTr !== null && incrTr < INCR_MIN) return null;
    const ho = stats(hold, lits, cellMean);
    const lv = stats(live, lits, cellMean);
    const pHo = ho.n ? bestParent(cacheHo, hold, lits, sign) : null;
    const incrHo = pHo === null || !ho.n ? null : sign * (ho.mean - pHo);
    const holdOk = ho.n >= MIN_HOLDOUT && Math.sign(ho.liftB) === sign && (incrHo === null || incrHo > 0);
    const liveStatus = lv.n < MIN_LIVE ? 'untested' : (Math.sign(lv.liftB) === sign ? 'agrees' : 'contradicts');
    return { cell: lits.map((l) => litName(names, l)).join(' + '), sign: sign > 0 ? '+' : '-', train: tr, holdout: ho, live: lv,
      incrTr, incrHo, replicated: holdOk && liveStatus !== 'contradicts', liveStatus };
  }
  const fmt = (c) => ({ cell: c.cell, sign: c.sign, replicated: c.replicated, live: c.liveStatus, incr: c.incrTr === null ? null : +c.incrTr.toFixed(2), incrHold: c.incrHo === null ? null : +c.incrHo.toFixed(2),
    train: { n: c.train.n, mean: +c.train.mean.toFixed(2), hit: +(100 * c.train.hit).toFixed(1), liftB: +c.train.liftB.toFixed(2), t: +c.train.t.toFixed(1) },
    holdout: c.holdout.n ? { n: c.holdout.n, mean: +c.holdout.mean.toFixed(2), hit: +(100 * c.holdout.hit).toFixed(1), liftB: +c.holdout.liftB.toFixed(2) } : { n: 0 },
    liveS: c.live.n ? { n: c.live.n, mean: +c.live.mean.toFixed(2), hit: +(100 * c.live.hit).toFixed(1), liftB: +c.live.liftB.toFixed(2) } : { n: 0 } });

  // singles
  const singles = []; let testedS = 0;
  for (const l of literals) { testedS++; const c = evaluate([l]); if (c) singles.push(c); }
  // pairs
  const pairs = []; let testedP = 0;
  for (let i = 0; i < literals.length; i++) for (let j = i + 1; j < literals.length; j++) {
    if (literals[i].f === literals[j].f) continue;
    testedP++; const c = evaluate([literals[i], literals[j]]); if (c) { c.lits = [literals[i], literals[j]]; pairs.push(c); }
  }
  pairs.sort((a, b) => Math.abs(b.train.t) - Math.abs(a.train.t));
  const repPairs = pairs.filter((c) => c.replicated);
  // triples grown from the strongest replicated pairs
  const triples = []; let testedT = 0; const seen = new Set();
  for (const p of repPairs.slice(0, TOP_PAIRS)) for (const l of literals) {
    if (p.lits.some((x) => x.f === l.f)) continue;
    const k3 = key([...p.lits, l]);
    if (seen.has(k3)) continue; seen.add(k3); testedT++;
    const c = evaluate([...p.lits, l]); if (c) triples.push(c);
  }
  triples.sort((a, b) => Math.abs(b.train.t) - Math.abs(a.train.t));
  const repTriples = triples.filter((c) => c.replicated);
  const byLift = (arr) => [...arr].sort((a, b) => b.holdout.liftB - a.holdout.liftB);
  return {
    market, features: nF, baseline,
    tested: { singles: testedS, pairs: testedP, triples: testedT },
    passedTrain: { singles: singles.length, pairs: pairs.length, triples: triples.length },
    replicated: { singles: singles.filter((c) => c.replicated).length, pairs: repPairs.length, triples: repTriples.length },
    topSingles: byLift(singles.filter((c) => c.replicated)).slice(0, 15).map(fmt),
    worstSingles: byLift(singles.filter((c) => c.replicated)).slice(-10).map(fmt),
    topPairs: byLift(repPairs).slice(0, 20).map(fmt),
    worstPairs: byLift(repPairs).slice(-10).map(fmt),
    topTriples: byLift(repTriples).slice(0, TOP_TRIPLES > 20 ? 20 : TOP_TRIPLES).map(fmt),
    worstTriples: byLift(repTriples).slice(-10).map(fmt),
  };
}

function runLab(rows, nameRows) {
  const names = {}; for (const r of nameRows || []) names[Number(r.idx)] = r.name;
  const all = prepare(rows);
  const markets = [...new Set(all.map((r) => r.market))].sort();
  return { rows: all.length, markets: markets.map((m) => runMarket(all, names, m)) };
}

if (typeof module !== 'undefined') module.exports = { runLab, prepare, stats, extBucket, rvolBucket, msBucket };
