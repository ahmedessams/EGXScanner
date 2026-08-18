# Architecture

## Design principle

The system is a measurable quantitative pipeline, not a prediction engine:

```
DATA → INDICATORS → MARKET STRUCTURE → SETUP DETECTION → SCORING → RANKING
  → NEXT-SESSION EVALUATION → HISTORICAL STATISTICS → (future) IMPROVE SCORING
```

Every scanner result is eventually checked against what actually happened
(`14-egx-prediction-evaluation`), and the whole pipeline can be replayed
point-in-time over history (`15-egx-backtest`) to measure how the scoring
would have performed — without ever letting a computation see data from
after the date it's scoring (see [BACKTESTING.md](BACKTESTING.md)).

## Layers

**n8n** is simultaneously the orchestration engine, the API client (HTTP
Request nodes calling the market data provider), the technical-analysis
engine and scoring engine (Code nodes running the JavaScript in `/code`),
and the reporting engine (webhook API + generated report text). There is no
separate backend service in v1.

**PostgreSQL** holds all persistent state: stock master data, daily OHLCV,
calculated indicators, support/resistance levels, volume analysis, scanner
runs/results, prediction evaluations, and configuration (scoring weights,
app settings). See [DATABASE.md](DATABASE.md).

## Workflow graph

```
01 Stock Universe
   │ (upserts stocks; marks stale symbols inactive)
   ▼
03 Daily Market Update ──────────────────────────────────┐
   │ (recent OHLCV upsert + EGX30 index + completeness    │ isTradingDay=false
   │  check → isTradingDay flag)                          ▼
   │ isTradingDay=true                              Skip - Non-Trading Day
   ▼
04 Technical Analysis
   │ (SMA/EMA/RSI/MACD/ATR/OBV/ROC/RVOL/trend, per stock/date)
   ▼
05 Support/Resistance
   │ (swing detection + ATR-clustering, per stock/date)
   ▼
06 Volume Analysis
   │ (volume-change %, cross-sectional rankings, accumulation score)
   ▼
   ├──────────────┬──────────────┬──────────────┐
   ▼              ▼              ▼              ▼
07 Breakout   08 Momentum   09 Pullback   10 Reversal      (each independently
   │              │              │              │           scores 0-100 and
   └──────────────┴──────────────┴──────────────┘           writes its own
                  │                                          column into
                  ▼                                          scanner_results)
           11 Overall Ranking
              (configurable-weight composite score, setup classification,
               liquidity eligibility, trade structure, market regime,
               overall_rank)
                  │
                  ▼
           13 Report API (webhooks, read-only)

            (independently, daily)                 (independently, on demand)
           14 Prediction Evaluation            15 Backtest
              (T+1 outcome capture)               (replays 04-11 per historical
                                                    date, then calls 14)

12 Daily Master Workflow orchestrates 01, 03, 04, 05, 06, 07, 08, 09, 10, 11
in sequence via Execute Workflow nodes, gated by the isTradingDay check.
02 Historical Import runs standalone (once, or periodically to re-backfill).
```

## The `scanner_run` handoff

`07`-`11` all share a `Get or Create Scanner Run` step: an idempotent
`INSERT ... ON CONFLICT (trading_date, run_type) DO UPDATE ... RETURNING id`
against `scanner_runs`. This means:

- Each scanner workflow can be tested standalone (it creates its own run if
  one doesn't exist yet for that date/run_type).
- When orchestrated by `12` or `15`, all five workflows converge on the SAME
  `scanner_run_id` for a given date, because the upsert is idempotent.
- `07`-`10` each write ONLY their own score column plus their own
  contribution to `reasons_json`/`warnings_json` (merged via `||` on
  conflict, never overwritten) — `11` is the only workflow that computes
  `overall_score`, `setup_type`, `overall_rank`, and the trade structure,
  and it does so only after reading back whatever `07`-`10` already wrote.
- `run_type` (`LIVE` vs `BACKTEST`) keeps live daily runs and simulated
  backtest runs from ever colliding on the same `(trading_date, run_type)`
  row, even when backtesting a date that also has a real live run.

## Why sub-workflows instead of one giant workflow

Each numbered workflow does one job, is independently testable via its own
Manual Trigger, and can be re-run in isolation to fix a partial failure
(e.g. re-running `06` alone after fixing a data issue) without re-running the
whole pipeline. `12` and `15` are pure orchestrators — they contain almost no
business logic of their own, just Execute Workflow calls and context
plumbing.

## Passing context between chained Execute Workflow calls

n8n's `Execute Workflow` node returns whatever items the CALLED workflow's
last node produced — not the caller's original input. Since every sub-workflow
in this project returns its own summary object (not `{asOfDate: ...}`), `12`
and `15` re-inject `{asOfDate, runType}` with a small "Prep for X" Code node
between every pair of Execute Workflow calls. If you add a new step to the
master or backtest sequence, keep this pattern — a chain of Execute Workflow
nodes with no reset step in between will silently lose `asOfDate` after the
first hop (every downstream sub-workflow then falls back to "today", not the
date you intended).
