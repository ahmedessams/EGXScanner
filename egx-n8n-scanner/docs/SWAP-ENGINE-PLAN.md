# Swap-Opportunity Engine — plan (2026-09-18)

Goal: compare the full state of a held position A against a candidate B and
say whether swapping is worth two round trips, using only signals that have
PROVEN incremental value on both slices (BACKTEST and LIVE, both markets).
Detectors are cheap; the score and the swap decision only use validated
cells. Rule of the project: nothing enters ranking, EV or the swap decision
without passing the two-slice walk-forward test (docs/SCORING.md).

## Phases

| # | Phase | Output | Gate to next |
|---|---|---|---|
| 0 | Feature inventory | `docs/FEATURES.md`: every signal already stored, coverage %, source table, what is missing | Agreed feature list |
| 1 | State vector | `lab_features` (one row per Top-30 pick, both markets, 2021→now): ~60 binary/bucketed features packed as a bitmask + outcome + mark-to-market realized + slice labels. New cheap detectors computed in SQL from candles at lab time (candlesticks, BB/KC squeeze, Donchian position, MFI/CMF, prev-week/month H/L proximity, strong-close persistence). No pipeline change. | Table built, coverage checked |
| 2 | Confluence discovery | Lab enumerating 2- and 3-feature conjunctions on TRAIN (2021–2024), replicated on HOLDOUT (2025–26) and LIVE; support ≥200 train / ≥50 holdout; lift vs (a) unconditional Top-10 rate and (b) the pick's extension×RVOL×market-score cell. Report = the short list of cells that replicate. | ≥1 cell replicates, or a documented negative |
| 3 | Ship validated cells | Add replicated cells to `probability_context_stats` / `context_probability()` (wf16 refresh), EV picks them up automatically; docs/SCORING.md updated | Brier / realized improves on both slices |
| 4 | Swap comparator | `GET /swap?market=&held=A,B,…`: for each held position, remaining expectancy (from its cell + days left) vs best candidate's EV net − 2 × round-trip cost; dashboard My Slots shows "swap → X (+y%)" only when the edge clears cost | Live for 4 weeks, tracked in Track Record |
| 5 | Exit management | Evaluate rule C (stop→breakeven after 50% of T1) as a parallel outcome in wf16; show the breakeven trigger on Trade Ideas | Both slices confirm |
| 6 | Regime & breadth as first-class features | Breadth thrust, % above EMAs, index trend, volatility regime, sector participation → into phase-2 lab specifically against the 2022/2024 loss years | Loss-year drawdown reduced without killing 2023/2025 |
| 7 | ML ranker (walk-forward only) | Gradient-boosted ranker over the state vector, trained ≤2024, tested 2025–26 + LIVE, compared against the confluence cells, never assumed better | Beats cells on holdout AND LIVE |

Out of scope until a data source exists: bid/ask, delta, footprint, intraday
or multi-timeframe structure, news, sentiment, analyst revisions, fundamentals
beyond dividends.

## Guardrails

- Multiple comparisons: with ~60 features there are ~1,800 pairs and ~34,000
  triples. A cell counts only if it replicates on holdout with the same sign
  AND the LIVE slice does not contradict it. Report the number of cells tested
  next to the number that passed.
- Baseline (b) matters more than (a): a cell that beats the unconditional
  rate but not its own extension×RVOL cell adds nothing.
- Survivorship: pre-2025 backtest universe = today's active list. Any cell
  whose edge is concentrated in thin names is flagged.
- Labs run through ZZ scratch workflows; per-candidate lookups go through
  indexed TEMP tables; payloads to n8n Code nodes are packed (bitmask), not
  wide rows; archive helpers after use.
- Never overwrite LIVE rows; never lower a gate to make a cell pass.

## Log

- 2026-09-18 — plan written; Phase 0 DONE (docs/FEATURES.md: ~120 stored
  signals, coverage, vocabularies, quartiles). Phase 1 DONE: `lab_features`
  built live in 4 min (49,426 Top-30 picks: EGX TRAIN 28,585 / HOLDOUT 11,683 /
  LIVE 670; US backtest 7,860 [starts 2025-08 → split at 2026-04-01 for the
  lab] / LIVE 628; 97 bits, 0 malformed). Phase 2 DONE (7.5 s): EGX tested
  194 literals / 18,624 pairs / 25,503 triples → replicated 6 / 140 / 919
  (correlated). ONE new signal family: close_at_high20 / close_at_high50
  (Donchian breakout close): lift +1.2..+2.1 over the pick's ext×RVOL×ms
  cell, 52% hit vs 34%, +3.3% vs +0.5% MTM; holds in EVERY year 2021–26,
  both liquidity tiers, LIVE 70% hit (n23). Ichimoku cloud_dist≥20 adds
  incrementally on top (+1.3..1.7). Avoid-state: volatility top quartile &
  not ≥10% above cloud (negative 5 of 6 years). Everything else (RSI, MACD,
  EMAs, SMC alone, Ichimoku alone, candles alone) is absorbed by the
  existing context cell. US: avoid-cells only (near resistance + index up).
  Gate to Phase 3 met.
- 2026-09-18 — Phase 3 gate: walk-forward Brier EGX HOLDOUT ERM 0.2358 →
  ERMH 0.2354 (ERH 0.2338); LIVE ERM 0.2591 → ERMH 0.2611 (ERH 0.2572).
  Rare cell (5–10% of picks) → aggregate Brier is the wrong yardstick; hi
  picks predicted 47% vs actual 50% holdout, 40% vs 70% live. Decision
  pending with user: (a) ship as separate measured flag + swap input
  (recommended, additive), or (b) restructure grid to ext×rvol×hi.
