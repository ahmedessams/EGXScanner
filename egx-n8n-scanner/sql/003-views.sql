-- =====================================================================
-- EGX N8N Scanner - Views
-- Run after 002-indexes.sql
-- Consumed directly by 13-egx-report-api.json (webhook endpoints)
--
-- NOTE if re-applying this file against a database that already has these
-- views from an older version of this file: Postgres refuses CREATE OR
-- REPLACE VIEW when a column's data type changes (e.g. the float8/int casts
-- added below). Run `DROP VIEW IF EXISTS v_full_market, v_scanner_top;`
-- first, then re-run this file. Not an issue on a fresh install.
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_latest_scanner_run: most recent completed LIVE run
-- ---------------------------------------------------------------------
-- Explicitly EGX-scoped (not just implicitly, now that scanner_runs spans
-- multiple markets) — this view's whole contract is "the one single latest
-- run, unchanged since before multi-market support", consumed by
-- v_full_market below which makes the same "always EGX, untouched" promise.
-- scanner_run_as_of(p_date, p_market) below is the general, multi-market
-- version everything else should use.
CREATE OR REPLACE VIEW v_latest_scanner_run AS
SELECT sr.*
FROM scanner_runs sr
WHERE sr.run_type = 'LIVE'
  AND sr.status = 'COMPLETED'
  AND sr.market = 'EGX'
ORDER BY sr.trading_date DESC
LIMIT 1;

-- ---------------------------------------------------------------------
-- v_latest_prices: latest daily_prices row per stock, with day-over-day change
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_latest_prices AS
SELECT DISTINCT ON (dp.stock_id)
    dp.stock_id,
    dp.trading_date,
    dp.open, dp.high, dp.low, dp.close,
    dp.volume, dp.traded_value, dp.number_of_trades,
    prev.close AS previous_close,
    CASE
        WHEN prev.close IS NULL OR prev.close = 0 THEN NULL
        ELSE ROUND(((dp.close - prev.close) / prev.close) * 100, 4)
    END AS change_pct
FROM daily_prices dp
LEFT JOIN LATERAL (
    SELECT close
    FROM daily_prices p2
    WHERE p2.stock_id = dp.stock_id
      AND p2.trading_date < dp.trading_date
    ORDER BY p2.trading_date DESC
    LIMIT 1
) prev ON TRUE
ORDER BY dp.stock_id, dp.trading_date DESC;

-- ---------------------------------------------------------------------
-- scanner_run_as_of / prices_as_of: parameterized siblings of
-- v_latest_scanner_run / v_latest_prices, for the dashboard's per-tab date
-- filter (spec: user-requested addition — "add a filter by date in each
-- tab"). p_date IS NULL reproduces the exact "always latest" behavior of
-- the views above (never a behavior change for existing callers); a real
-- date gives the most recent qualifying row ON OR BEFORE that date, so
-- picking a non-trading day (weekend/holiday) still resolves sensibly.
-- ---------------------------------------------------------------------
-- p_market defaults to 'EGX' so every existing single-arg caller
-- (scanner_run_as_of($1)) keeps its exact prior EGX-only behavior
-- unchanged. CREATE OR REPLACE does NOT collapse this into the old
-- single-arg version, though — Postgres identifies functions by name AND
-- argument list, so adding a parameter (even a defaulted one) creates a
-- SEPARATE overload alongside the old one rather than replacing it
-- (confirmed live: re-applying this file left both scanner_run_as_of(date)
-- and scanner_run_as_of(date, varchar) defined simultaneously, and the
-- next CREATE FUNCTION in this file failed with "function name ... is not
-- unique"). The explicit DROP below is required, not just tidiness.
DROP FUNCTION IF EXISTS scanner_run_as_of(DATE);
CREATE OR REPLACE FUNCTION scanner_run_as_of(p_date DATE, p_market VARCHAR DEFAULT 'EGX')
RETURNS SETOF scanner_runs AS $$
  SELECT sr.*
  FROM scanner_runs sr
  WHERE sr.run_type = 'LIVE'
    AND sr.status = 'COMPLETED'
    AND sr.market = p_market
    AND (p_date IS NULL OR sr.trading_date <= p_date)
  ORDER BY sr.trading_date DESC
  LIMIT 1;
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION scanner_run_as_of IS 'Most recent completed LIVE scanner run for p_market on or before p_date (or the true latest when p_date IS NULL) — parameterized, multi-market sibling of v_latest_scanner_run.';

CREATE OR REPLACE FUNCTION prices_as_of(p_date DATE)
RETURNS TABLE (
    stock_id BIGINT, trading_date DATE, open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC,
    volume BIGINT, traded_value NUMERIC, number_of_trades INTEGER, previous_close NUMERIC, change_pct NUMERIC
) AS $$
  SELECT DISTINCT ON (dp.stock_id)
      dp.stock_id, dp.trading_date, dp.open, dp.high, dp.low, dp.close,
      dp.volume, dp.traded_value, dp.number_of_trades,
      prev.close AS previous_close,
      CASE
          WHEN prev.close IS NULL OR prev.close = 0 THEN NULL
          ELSE ROUND(((dp.close - prev.close) / prev.close) * 100, 4)
      END AS change_pct
  FROM daily_prices dp
  LEFT JOIN LATERAL (
      SELECT close FROM daily_prices p2
      WHERE p2.stock_id = dp.stock_id AND p2.trading_date < dp.trading_date
      ORDER BY p2.trading_date DESC LIMIT 1
  ) prev ON TRUE
  WHERE p_date IS NULL OR dp.trading_date <= p_date
  ORDER BY dp.stock_id, dp.trading_date DESC;
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION prices_as_of IS 'Per-stock latest daily_prices row on or before p_date (or the true latest when p_date IS NULL) — parameterized sibling of v_latest_prices.';

-- ---------------------------------------------------------------------
-- v_full_market: the "all EGX stocks" sortable table (section 36)
-- ---------------------------------------------------------------------
-- NOTE: every NUMERIC/BIGINT column below is explicitly cast to float8/int.
-- The Postgres driver (and therefore every n8n Postgres node and any other
-- JSON API consumer) returns raw NUMERIC/BIGINT columns as STRINGS to avoid
-- JS float-precision loss — confirmed via live E2E testing, where this
-- silently broke isNumber()/arithmetic in every downstream Code node until
-- fixed here. Bare DATE columns have a related but different problem: the
-- driver turns them into JS Date objects, which get serialized with a UTC
-- offset applied whenever they cross a JSON boundary (e.g. an n8n Execute
-- Workflow call) — this silently shifted dates backward by a few hours in a
-- UTC+3 timezone during live E2E testing, corrupting a date COMPARISON
-- downstream. Both are fixed the same way: cast to ::float8/::int or ::text
-- respectively. json_agg()/row_to_json() are unaffected by either problem
-- (Postgres serializes both numeric and date types as genuine JSON
-- numbers/strings through those functions) — the bug only bites bare scalar
-- column selections like this view.
CREATE OR REPLACE VIEW v_full_market AS
SELECT
    s.id::int AS stock_id,
    s.symbol,
    s.name,
    s.sector,
    s.active,

    lp.trading_date::text AS trading_date,
    lp.open::float8 AS open, lp.high::float8 AS high, lp.low::float8 AS low,
    lp.close::float8 AS close, lp.change_pct::float8 AS change_pct,
    lp.volume::float8 AS volume, lp.traded_value::float8 AS traded_value,

    ta.volume_sma20::float8 AS avg_volume20,
    ta.relative_volume20::float8 AS rvol20,
    ta.relative_volume50::float8 AS rvol50,
    ta.rsi14::float8 AS rsi14,
    ta.ema9::float8 AS ema9, ta.ema20::float8 AS ema20, ta.ema50::float8 AS ema50, ta.ema200::float8 AS ema200,
    ta.macd::float8 AS macd, ta.macd_signal::float8 AS macd_signal, ta.macd_histogram::float8 AS macd_histogram,
    ta.atr14::float8 AS atr14,
    ta.short_term_trend, ta.medium_term_trend, ta.long_term_trend,

    srz.support1::float8 AS support1, srz.support2::float8 AS support2, srz.support3::float8 AS support3,
    srz.resistance1::float8 AS resistance1, srz.resistance2::float8 AS resistance2, srz.resistance3::float8 AS resistance3,

    va.volume_rank, va.traded_value_rank,
    va.relative_volume20_rank, va.relative_volume50_rank,
    va.accumulation_score::float8 AS accumulation_score,

    latest_run.id::int AS scanner_run_id,
    res.breakout_score::float8 AS breakout_score,
    res.momentum_score::float8 AS momentum_score,
    res.pullback_score::float8 AS pullback_score,
    res.reversal_score::float8 AS reversal_score,
    res.overall_score::float8 AS overall_score,
    res.setup_type,
    res.overall_rank,
    res.eligible,

    res.entry_price::float8 AS entry_price,
    res.invalidation_price::float8 AS invalidation_price,
    res.target1::float8 AS target1, res.target2::float8 AS target2, res.target3::float8 AS target3,
    res.risk_reward_t1::float8 AS risk_reward_t1, res.risk_reward_t2::float8 AS risk_reward_t2, res.risk_reward_t3::float8 AS risk_reward_t3,
    res.target1_gain_pct::float8 AS target1_gain_pct, res.target2_gain_pct::float8 AS target2_gain_pct, res.target3_gain_pct::float8 AS target3_gain_pct,
    res.target1_estimated_days, res.target2_estimated_days, res.target3_estimated_days,
    ps.target1_hit_pct::float8 AS historical_target1_hit_pct,
    ps.stop_hit_pct::float8 AS historical_stop_hit_pct,
    ps.sample_size AS historical_sample_size,
    res.ai_target1_probability_pct::float8 AS ai_target1_probability_pct,
    res.ai_rank_score::float8 AS ai_rank_score,
    res.ai_rank,
    res.ai_reasoning,
    -- Appended at the END, not grouped with the other ai_* columns above:
    -- CREATE OR REPLACE VIEW can only ADD columns at the end of the list,
    -- never insert/reorder existing ones (confirmed live: inserting this
    -- mid-list broke a real deploy with "cannot change name of view column
    -- ai_rank_score to ai_stop_probability_pct"). Nothing reads these views
    -- positionally (n8n's Postgres node returns column-name-keyed JSON), so
    -- the ordering has no functional effect.
    res.ai_stop_probability_pct::float8 AS ai_stop_probability_pct,
    -- Horizon estimates (2026-09-01, append-only as above): drift+volatility
    -- projection of the stock's own trailing-252-session log returns.
    ta.est_2w_pct::float8 AS est_2w_pct,
    ta.est_1m_pct::float8 AS est_1m_pct,
    ta.est_3m_pct::float8 AS est_3m_pct,
    ta.est_1y_pct::float8 AS est_1y_pct,
    ta.drift_annual_pct::float8 AS drift_annual_pct,
    ta.volatility_annual_pct::float8 AS volatility_annual_pct,
    -- Long-term quality (2026-09-01, append-only as above): durable-uptrend
    -- score + dividend signals (TTM yield, 5y payout count, TTM growth).
    ta.long_term_score::float8 AS long_term_score,
    dv.ttm::float8 AS dividend_ttm,
    (CASE WHEN lp.close > 0 THEN dv.ttm / lp.close * 100 END)::float8 AS dividend_yield_pct,
    COALESCE(dv.years_paid_5y, 0)::int AS dividend_years_paid_5y,
    (CASE WHEN dv.prior_ttm > 0 THEN (dv.ttm / dv.prior_ttm - 1) * 100 END)::float8 AS dividend_growth_pct

FROM stocks s
LEFT JOIN v_latest_prices lp ON lp.stock_id = s.id
LEFT JOIN technical_analysis ta
    ON ta.stock_id = s.id AND ta.trading_date = lp.trading_date
LEFT JOIN support_resistance srz
    ON srz.stock_id = s.id AND srz.trading_date = lp.trading_date
LEFT JOIN volume_analysis va
    ON va.stock_id = s.id AND va.trading_date = lp.trading_date
LEFT JOIN LATERAL (
    SELECT
        SUM(d.value) FILTER (WHERE d.ex_date > lp.trading_date - INTERVAL '365 days') AS ttm,
        SUM(d.value) FILTER (WHERE d.ex_date <= lp.trading_date - INTERVAL '365 days'
                             AND d.ex_date > lp.trading_date - INTERVAL '730 days') AS prior_ttm,
        COUNT(DISTINCT EXTRACT(YEAR FROM d.ex_date)) FILTER (
            WHERE d.ex_date >= make_date(EXTRACT(YEAR FROM lp.trading_date)::int - 5, 1, 1)
              AND d.ex_date <  make_date(EXTRACT(YEAR FROM lp.trading_date)::int, 1, 1)) AS years_paid_5y
    FROM dividends d
    WHERE d.stock_id = s.id AND d.ex_date <= lp.trading_date
) dv ON TRUE
LEFT JOIN v_latest_scanner_run latest_run ON TRUE
LEFT JOIN scanner_results res
    ON res.stock_id = s.id AND res.scanner_run_id = latest_run.id
LEFT JOIN probability_stats ps ON ps.setup_type = res.setup_type AND ps.market = 'EGX'
WHERE s.active = TRUE AND s.exchange = 'EGX';

COMMENT ON VIEW v_full_market IS 'One row per active EGX stock with latest price/indicator/scanner snapshot — explicitly EGX-scoped, unchanged since before multi-market support (see v_latest_scanner_run comment). market_snapshot(p_date, p_market) below is the general, multi-market sibling; used by GET /webhook/egx/stocks';

-- ---------------------------------------------------------------------
-- market_snapshot(p_date): parameterized sibling of v_full_market for the
-- dashboard's date filter. RETURNS SETOF v_full_market reuses that view's
-- already-defined row type instead of re-declaring ~45 column types by
-- hand — v_full_market itself is untouched and keeps its exact current
-- "always latest" behavior; market_snapshot(NULL) reproduces that same
-- behavior exactly (via scanner_run_as_of/prices_as_of's NULL handling).
-- Same DROP-before-CREATE requirement as scanner_run_as_of above: adding a
-- parameter is a new overload, not a replacement of the old single-arg form.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS market_snapshot(DATE);
CREATE OR REPLACE FUNCTION market_snapshot(p_date DATE, p_market VARCHAR DEFAULT 'EGX')
RETURNS SETOF v_full_market AS $$
  -- anchor: prices are served as of the last FULLY ANALYZED date (the
  -- completed run's trading_date), not the raw latest price date. Without
  -- this, the nightly window between a market's price import and its
  -- analysis run (US: ~23:00 -> 03:00 Cairo) showed fresh prices with NULL
  -- rsi/support/resistance/rvol AND the previous run's scores beside them —
  -- a misleading mixed-date row (found live 2026-08-21, "many data is
  -- missing in USA stocks"). COALESCE keeps the old behavior (latest
  -- prices, null analysis) for a market with no completed run yet.
  --
  -- lp is a per-stock LATERAL top-1 index scan on (stock_id, trading_date)
  -- instead of the old prices_as_of() call. Two hard-won performance
  -- constraints (both confirmed live): prices_as_of(run.trading_date) made
  -- the function-join LATERAL on run, re-running the full-table DISTINCT ON
  -- once per stock (~90s+ timeouts); prices_as_of(<scalar subquery>)
  -- avoided that but blocked SQL-function inlining, materializing the whole
  -- 360k-row DISTINCT ON as an opaque function scan (~23s). The lateral
  -- top-1 form is ~100ms.
  WITH anchor AS (
    SELECT COALESCE((SELECT r.trading_date FROM scanner_run_as_of(p_date, p_market) r), p_date) AS d
  )
  SELECT
      s.id::int AS stock_id, s.symbol, s.name, s.sector, s.active,

      lp.trading_date::text AS trading_date,
      lp.open::float8 AS open, lp.high::float8 AS high, lp.low::float8 AS low,
      lp.close::float8 AS close,
      CASE
          WHEN lp.previous_close IS NULL OR lp.previous_close = 0 THEN NULL
          ELSE ROUND(((lp.close - lp.previous_close) / lp.previous_close) * 100, 4)
      END::float8 AS change_pct,
      lp.volume::float8 AS volume, lp.traded_value::float8 AS traded_value,

      ta.volume_sma20::float8 AS avg_volume20,
      ta.relative_volume20::float8 AS rvol20,
      ta.relative_volume50::float8 AS rvol50,
      ta.rsi14::float8 AS rsi14,
      ta.ema9::float8 AS ema9, ta.ema20::float8 AS ema20, ta.ema50::float8 AS ema50, ta.ema200::float8 AS ema200,
      ta.macd::float8 AS macd, ta.macd_signal::float8 AS macd_signal, ta.macd_histogram::float8 AS macd_histogram,
      ta.atr14::float8 AS atr14,
      ta.short_term_trend, ta.medium_term_trend, ta.long_term_trend,

      srz.support1::float8 AS support1, srz.support2::float8 AS support2, srz.support3::float8 AS support3,
      srz.resistance1::float8 AS resistance1, srz.resistance2::float8 AS resistance2, srz.resistance3::float8 AS resistance3,

      va.volume_rank, va.traded_value_rank,
      va.relative_volume20_rank, va.relative_volume50_rank,
      va.accumulation_score::float8 AS accumulation_score,

      run.id::int AS scanner_run_id,
      res.breakout_score::float8 AS breakout_score,
      res.momentum_score::float8 AS momentum_score,
      res.pullback_score::float8 AS pullback_score,
      res.reversal_score::float8 AS reversal_score,
      res.overall_score::float8 AS overall_score,
      res.setup_type,
      res.overall_rank,
      res.eligible,

      res.entry_price::float8 AS entry_price,
      res.invalidation_price::float8 AS invalidation_price,
      res.target1::float8 AS target1, res.target2::float8 AS target2, res.target3::float8 AS target3,
      res.risk_reward_t1::float8 AS risk_reward_t1, res.risk_reward_t2::float8 AS risk_reward_t2, res.risk_reward_t3::float8 AS risk_reward_t3,
      res.target1_gain_pct::float8 AS target1_gain_pct, res.target2_gain_pct::float8 AS target2_gain_pct, res.target3_gain_pct::float8 AS target3_gain_pct,
      res.target1_estimated_days, res.target2_estimated_days, res.target3_estimated_days,
      ps.target1_hit_pct::float8 AS historical_target1_hit_pct,
      ps.stop_hit_pct::float8 AS historical_stop_hit_pct,
      ps.sample_size AS historical_sample_size,
      res.ai_target1_probability_pct::float8 AS ai_target1_probability_pct,
      res.ai_rank_score::float8 AS ai_rank_score,
      res.ai_rank,
      res.ai_reasoning,
      -- Same column order as v_full_market's SELECT list, appended at the
      -- end (see the comment on that view's definition) — this function's
      -- RETURNS SETOF v_full_market requires an exact positional match.
      res.ai_stop_probability_pct::float8 AS ai_stop_probability_pct,
      -- Horizon estimates (2026-09-01, append-only as above): drift+volatility
      -- projection of the stock's own trailing-252-session log returns.
      ta.est_2w_pct::float8 AS est_2w_pct,
      ta.est_1m_pct::float8 AS est_1m_pct,
      ta.est_3m_pct::float8 AS est_3m_pct,
      ta.est_1y_pct::float8 AS est_1y_pct,
      ta.drift_annual_pct::float8 AS drift_annual_pct,
      ta.volatility_annual_pct::float8 AS volatility_annual_pct,
      -- Long-term quality (2026-09-01, append-only as above): durable-uptrend
      -- score + dividend signals (TTM yield, 5y payout count, TTM growth).
      ta.long_term_score::float8 AS long_term_score,
      dv.ttm::float8 AS dividend_ttm,
      (CASE WHEN lp.close > 0 THEN dv.ttm / lp.close * 100 END)::float8 AS dividend_yield_pct,
      COALESCE(dv.years_paid_5y, 0)::int AS dividend_years_paid_5y,
      (CASE WHEN dv.prior_ttm > 0 THEN (dv.ttm / dv.prior_ttm - 1) * 100 END)::float8 AS dividend_growth_pct

  FROM stocks s
  CROSS JOIN anchor a
  LEFT JOIN LATERAL (
      SELECT dp.trading_date, dp.open, dp.high, dp.low, dp.close,
             dp.volume, dp.traded_value,
             prev.close AS previous_close
      FROM daily_prices dp
      LEFT JOIN LATERAL (
          SELECT p2.close FROM daily_prices p2
          WHERE p2.stock_id = dp.stock_id AND p2.trading_date < dp.trading_date
          ORDER BY p2.trading_date DESC LIMIT 1
      ) prev ON TRUE
      WHERE dp.stock_id = s.id AND (a.d IS NULL OR dp.trading_date <= a.d)
      ORDER BY dp.trading_date DESC LIMIT 1
  ) lp ON TRUE
  LEFT JOIN technical_analysis ta
      ON ta.stock_id = s.id AND ta.trading_date = lp.trading_date
  LEFT JOIN support_resistance srz
      ON srz.stock_id = s.id AND srz.trading_date = lp.trading_date
  LEFT JOIN volume_analysis va
      ON va.stock_id = s.id AND va.trading_date = lp.trading_date
  LEFT JOIN LATERAL (
      SELECT
          SUM(d.value) FILTER (WHERE d.ex_date > lp.trading_date - INTERVAL '365 days') AS ttm,
          SUM(d.value) FILTER (WHERE d.ex_date <= lp.trading_date - INTERVAL '365 days'
                               AND d.ex_date > lp.trading_date - INTERVAL '730 days') AS prior_ttm,
          COUNT(DISTINCT EXTRACT(YEAR FROM d.ex_date)) FILTER (
              WHERE d.ex_date >= make_date(EXTRACT(YEAR FROM lp.trading_date)::int - 5, 1, 1)
                AND d.ex_date <  make_date(EXTRACT(YEAR FROM lp.trading_date)::int, 1, 1)) AS years_paid_5y
      FROM dividends d
      WHERE d.stock_id = s.id AND d.ex_date <= lp.trading_date
  ) dv ON TRUE
  LEFT JOIN scanner_run_as_of(p_date, p_market) run ON TRUE
  LEFT JOIN scanner_results res
      ON res.stock_id = s.id AND res.scanner_run_id = run.id
  LEFT JOIN probability_stats ps ON ps.setup_type = res.setup_type AND ps.market = p_market
  WHERE s.active = TRUE AND s.exchange = p_market;
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION market_snapshot IS 'Same row shape as v_full_market, parameterized to any historical date (on-or-before semantics; NULL = always latest, identical to v_full_market for p_market=EGX) and any market (default EGX, for backward-compatible single-arg callers). Backs GET /webhook/egx/stocks(/volume|/relative-volume)''s optional ?date=/?market= filters.';

-- ---------------------------------------------------------------------
-- v_scanner_top: latest run results joined with stock + price info, ranked
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_scanner_top AS
SELECT
    res.id::int AS scanner_result_id,
    res.scanner_run_id::int AS scanner_run_id,
    run.trading_date::text AS trading_date,
    s.id::int AS stock_id,
    s.symbol,
    s.name,
    s.sector,
    lp.close::float8 AS close,
    lp.change_pct::float8 AS change_pct,
    lp.volume::float8 AS volume,
    lp.traded_value::float8 AS traded_value,
    ta.rsi14::float8 AS rsi14,
    ta.relative_volume20::float8 AS rvol20,
    srz.support1::float8 AS support1, srz.resistance1::float8 AS resistance1,
    res.overall_rank,
    res.overall_score::float8 AS overall_score,
    res.breakout_score::float8 AS breakout_score,
    res.momentum_score::float8 AS momentum_score,
    res.pullback_score::float8 AS pullback_score,
    res.reversal_score::float8 AS reversal_score,
    res.accumulation_score::float8 AS accumulation_score,
    res.setup_type,
    res.eligible,
    res.entry_price::float8 AS entry_price,
    res.invalidation_price::float8 AS invalidation_price,
    res.target1::float8 AS target1, res.target2::float8 AS target2, res.target3::float8 AS target3,
    res.risk_reward_t1::float8 AS risk_reward_t1, res.risk_reward_t2::float8 AS risk_reward_t2, res.risk_reward_t3::float8 AS risk_reward_t3,
    res.target1_gain_pct::float8 AS target1_gain_pct, res.target2_gain_pct::float8 AS target2_gain_pct, res.target3_gain_pct::float8 AS target3_gain_pct,
    res.target1_estimated_days, res.target2_estimated_days, res.target3_estimated_days,
    res.reasons_json,
    res.warnings_json,
    res.data_confidence::float8 AS data_confidence,
    res.setup_confidence::float8 AS setup_confidence,
    ps.target1_hit_pct::float8 AS historical_target1_hit_pct,
    ps.stop_hit_pct::float8 AS historical_stop_hit_pct,
    ps.sample_size AS historical_sample_size,
    res.ai_target1_probability_pct::float8 AS ai_target1_probability_pct,
    res.ai_rank_score::float8 AS ai_rank_score,
    res.ai_rank,
    res.ai_reasoning,
    -- Appended at the end for the same reason as v_full_market above.
    res.ai_stop_probability_pct::float8 AS ai_stop_probability_pct,
    -- Forecast-vs-actual for the pick's own T1 window (user-requested):
    -- the actual highest high / lowest low over the target1_estimated_days
    -- sessions AFTER the scan date, plus how many of those sessions exist
    -- yet, and the evaluated outcome from 16-egx-target-window-evaluation.
    -- window_outcome is NULL until 16 evaluates the pick (weekly schedule,
    -- and only once the full window has elapsed) — the webapp shows that
    -- as Pending. Same append-only rule as the columns above.
    win.actual_window_high,
    win.actual_window_low,
    win.window_sessions_elapsed,
    twe.outcome AS window_outcome,
    twe.resolved_day_number,
    -- Next-session range estimate for this pick (user-requested): the same
    -- close +/- ATR14 band that 18-egx-range-forecast stores per stock per
    -- trading date and the Next Estimate tab shows, joined on the scan date
    -- so it is the estimate that was available WHEN the pick was made.
    -- accuracy_pct is the stock's own expanding-window containment rate as
    -- of that date. Same append-only rule as the columns above.
    rf.next_high_estimate::float8 AS next_day_high_estimate,
    rf.next_low_estimate::float8 AS next_day_low_estimate,
    rf.accuracy_pct::float8 AS range_forecast_accuracy_pct,
    -- The same band as gain/loss % vs the scan-date close (rf.close, not
    -- lp.close: the latter is the latest/anchored close, which differs from
    -- the scan date when browsing history). Append-only, as above.
    ((rf.next_high_estimate - rf.close) / NULLIF(rf.close, 0) * 100)::float8 AS next_day_high_estimate_pct,
    ((rf.next_low_estimate - rf.close) / NULLIF(rf.close, 0) * 100)::float8 AS next_day_low_estimate_pct,
    -- Horizon estimates (2026-09-01, append-only as above): drift projection
    -- of the stock's own trailing-252-session log returns, as of the run date.
    ta.est_2w_pct::float8 AS est_2w_pct,
    ta.est_1m_pct::float8 AS est_1m_pct,
    ta.est_3m_pct::float8 AS est_3m_pct,
    ta.est_1y_pct::float8 AS est_1y_pct,
    -- Long-term quality (2026-09-01, append-only as above).
    ta.long_term_score::float8 AS long_term_score,
    (CASE WHEN lp.close > 0 THEN dv.ttm / lp.close * 100 END)::float8 AS dividend_yield_pct
FROM scanner_results res
JOIN scanner_runs run ON run.id = res.scanner_run_id
JOIN stocks s ON s.id = res.stock_id
-- Price columns are AS OF THE RUN DATE, not the latest session. This used to
-- be v_latest_prices, which made Close / Chg % / Volume / Traded Value show
-- the newest session next to scan-date scores and targets whenever a past
-- date was viewed (found 2026-08-30: WKOL 2026-08-17 showed close 347.66 in
-- the Top 10 while the true Aug-17 close, and the detail drawer, said
-- 376.61). Same per-stock top-1 LATERAL shape as market_snapshot().
LEFT JOIN LATERAL (
    SELECT dp.trading_date, dp.close, dp.volume, dp.traded_value,
           CASE
               WHEN prev.close IS NULL OR prev.close = 0 THEN NULL
               ELSE ROUND(((dp.close - prev.close) / prev.close) * 100, 4)
           END AS change_pct
    FROM daily_prices dp
    LEFT JOIN LATERAL (
        SELECT p2.close FROM daily_prices p2
        WHERE p2.stock_id = dp.stock_id AND p2.trading_date < dp.trading_date
        ORDER BY p2.trading_date DESC LIMIT 1
    ) prev ON TRUE
    WHERE dp.stock_id = s.id AND dp.trading_date <= run.trading_date
    ORDER BY dp.trading_date DESC LIMIT 1
) lp ON TRUE
LEFT JOIN technical_analysis ta
    ON ta.stock_id = s.id AND ta.trading_date = run.trading_date
LEFT JOIN support_resistance srz
    ON srz.stock_id = s.id AND srz.trading_date = run.trading_date
-- ps.market = run.market (not a fixed value): this view spans every run,
-- every market — probability_stats' PK is now (setup_type, market), so
-- joining on setup_type alone would multiply rows (one per market per
-- setup_type) once more than one market has stats. run.market gives the
-- correct per-row market context directly, no separate parameter needed.
LEFT JOIN LATERAL (
    SELECT SUM(d.value) FILTER (WHERE d.ex_date > run.trading_date - INTERVAL '365 days') AS ttm
    FROM dividends d
    WHERE d.stock_id = s.id AND d.ex_date <= run.trading_date
) dv ON TRUE
LEFT JOIN probability_stats ps ON ps.setup_type = res.setup_type AND ps.market = run.market
LEFT JOIN target_window_evaluation twe ON twe.scanner_result_id = res.id
LEFT JOIN range_forecast rf ON rf.stock_id = res.stock_id AND rf.trading_date = run.trading_date
LEFT JOIN LATERAL (
    SELECT MAX(w.high)::float8 AS actual_window_high,
           MIN(w.low)::float8 AS actual_window_low,
           COUNT(*)::int AS window_sessions_elapsed
    FROM (
        SELECT dp.high, dp.low
        FROM daily_prices dp
        WHERE dp.stock_id = res.stock_id AND dp.trading_date > run.trading_date
        ORDER BY dp.trading_date ASC
        LIMIT GREATEST(COALESCE(res.target1_estimated_days, 0), 0)
    ) w
) win ON TRUE;

COMMENT ON VIEW v_scanner_top IS 'Flattened scanner_results for the latest or any given run/market, used by ranking webhook endpoints — callers scope both via scanner_run_as_of(p_date, p_market)';

-- ---------------------------------------------------------------------
-- v_prediction_stats: aggregate success metrics grouped by setup_type
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_prediction_stats_by_setup AS
SELECT
    res.setup_type,
    COUNT(*) AS sample_size,
    ROUND(AVG(CASE WHEN pe.return_previous_close_to_close_pct > 0 THEN 1 ELSE 0 END) * 100, 2) AS positive_close_rate_pct,
    ROUND(AVG(pe.return_previous_close_to_close_pct), 4) AS avg_return_pct,
    ROUND(AVG(pe.maximum_favorable_excursion_pct), 4) AS avg_mfe_pct,
    ROUND(AVG(pe.maximum_adverse_excursion_pct), 4) AS avg_mae_pct,
    ROUND(AVG(CASE WHEN pe.target1_hit THEN 1 ELSE 0 END) * 100, 2) AS target1_hit_rate_pct,
    ROUND(AVG(CASE WHEN pe.target2_hit THEN 1 ELSE 0 END) * 100, 2) AS target2_hit_rate_pct,
    ROUND(AVG(CASE WHEN pe.stop_hit THEN 1 ELSE 0 END) * 100, 2) AS stop_hit_rate_pct
FROM prediction_evaluation pe
JOIN scanner_results res ON res.id = pe.scanner_result_id
GROUP BY res.setup_type;

COMMENT ON VIEW v_prediction_stats_by_setup IS 'Historical Probability metrics grouped by setup type (section 28)';
