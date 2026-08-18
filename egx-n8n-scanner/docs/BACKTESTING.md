# Backtesting

`15-egx-backtest` replays the exact same point-in-time pipeline used for
live scanning (`04`→`05`→`06`→`07`→`08`→`09`→`10`→`11`) once per historical
trading date in a requested range, then evaluates the results with `14`.
There is no separate "backtest scoring logic" — this is deliberate: a
second, parallel implementation of the scoring rules would inevitably drift
from the live one and make backtest results meaningless.

## How "no look-ahead" is actually enforced

Every per-stock query across `04`, `05`, `06`, and the four scanners filters
on `trading_date <= $asOfDate` (or `= $asOfDate` for same-day joins). When
`15` calls these workflows for a historical date, `$asOfDate` is that
historical date — so, structurally, none of them can see a row dated after
it. This is the same code path live scanning uses; a backtest for
2026-03-15 queries the database exactly as if it were actually 2026-03-15,
because as far as those queries are concerned, it is.

The one place FUTURE data is intentionally read is `14-egx-prediction-
evaluation`, and only under two conditions simultaneously: the target date
is strictly AFTER the scan date, AND that future row already exists in
`daily_prices` (checked via `EXISTS`) — which for a backtest is always true
immediately, since all the historical data was imported up front.

## `run_type` isolation

`15` passes `runType: 'BACKTEST'` through to `07`-`11`'s shared `Get or
Create Scanner Run` step, which upserts on `(trading_date, run_type)`. A
backtest over dates that also have real `LIVE` scanner runs never reads or
overwrites those live rows — they're entirely separate `scanner_runs` rows
sharing only the same `trading_date`.

## What `success` and the hit-rate metrics actually mean

Daily OHLC data cannot tell you the INTRADAY order two price levels were
touched in. If a session's low touched the invalidation price AND its high
touched target1, we genuinely don't know from `daily_prices` alone which
happened first. `14` resolves this conservatively:

```
success = target1_hit === true && stop_hit !== true
```

i.e. a session only counts as a win if the stop was NOT also touched that
day — ambiguous same-day double-touches are treated as failures, not wins.
This under-counts true successes in exchange for never over-claiming one.
If you need finer resolution, you'd need intraday data, which is out of
scope for v1.

`maximum_favorable_excursion_pct` / `maximum_adverse_excursion_pct` are
computed from the session's high/low relative to the PREVIOUS close (not the
entry price), matching spec section 27's worked example:

```
Previous close = 10, Next high = 10.70, Next low = 9.80, Next close = 10.40
MFE = +7%, MAE = -2%, Close return = +4%
```

## Parameters

```jsonc
{
  "startDate": "2026-01-01",   // inclusive
  "endDate": "2026-06-30",     // inclusive
  "minimumScore": 60,          // filters the FINAL aggregate metrics query, not the scan itself — every eligible stock is still scored and ranked every day
  "setupType": "BREAKOUT",     // or "ANY" (default)
  "topN": 10                   // rank cutoff for the aggregate metrics query
}
```

`minimumScore`/`setupType`/`topN` only affect the final "Aggregate Backtest
Metrics" query — they answer "how would a strategy that only acted on
BREAKOUT setups scoring 60+ in the daily Top 10 have performed", without
needing to re-run the scan itself for each hypothesis. Change them and
re-run just the aggregate step (or re-run the whole workflow — it's
idempotent, the loop's `Execute Workflow` calls into `07`-`11` will simply
update the same `BACKTEST` rows again).

## Cost

The loop is sequential (`batchSize: 1` in `Loop Over Trading Dates`) and
calls 8 sub-workflows per date, each of which loops over every active stock.
A 90-day backtest over ~250 stocks is on the order of 90 × 250 × 8 ≈ 180,000
node executions. Start with a short date range (a few weeks) to validate
your setup before running a multi-month backtest.

## Validating no-look-ahead yourself

If you want to independently confirm no future data leaked into a backtest
run, this query should return zero rows for any `BACKTEST` scanner_run:

```sql
SELECT r.id, r.stock_id, run.trading_date
FROM scanner_results r
JOIN scanner_runs run ON run.id = r.scanner_run_id
JOIN technical_analysis ta ON ta.stock_id = r.stock_id
WHERE run.run_type = 'BACKTEST'
  AND ta.trading_date > run.trading_date
  AND ta.stock_id = r.stock_id;
```

(This checks that no `technical_analysis` row dated after the scan date
exists for a stock that was scored in that run — it doesn't prove a query
USED such a row, but combined with the query-shape guarantee above, it's a
strong sanity check that no such row could even have been visible.)
