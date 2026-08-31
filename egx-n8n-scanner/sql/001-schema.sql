-- =====================================================================
-- EGX N8N Scanner - Core Schema
-- =====================================================================
-- Applies cleanly to a fresh PostgreSQL 14+ database.
-- Run 001-schema.sql -> 002-indexes.sql -> 003-views.sql -> 004-seed-settings.sql
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------
-- stocks: master list of EGX-listed securities
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stocks (
    id              BIGSERIAL PRIMARY KEY,
    symbol          VARCHAR(32)  NOT NULL,
    name            VARCHAR(255) NOT NULL,
    isin            VARCHAR(32),
    sector          VARCHAR(128),
    exchange        VARCHAR(16)  NOT NULL DEFAULT 'EGX',
    currency        VARCHAR(8)   NOT NULL DEFAULT 'EGP',
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    first_seen      DATE,
    last_seen       DATE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Manual blocklist for provider-alias/duplicate listings (e.g. EODHD
    -- serves the same EGX security under both its legacy and current symbol
    -- with identical OHLCV). Workflow 01's upsert sets active = NOT excluded
    -- on refresh, so excluding a symbol sticks across nightly universe runs;
    -- plain `active = FALSE` alone would be re-activated the next night.
    excluded        BOOLEAN      NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_stocks_exchange_symbol UNIQUE (exchange, symbol)
);

COMMENT ON TABLE stocks IS 'EGX stock universe / master data';

-- ---------------------------------------------------------------------
-- markets: multi-market config (user-requested addition beyond the
-- original single-market/EGX spec). One row per market the pipeline
-- knows how to scan — currency, timezone, the EODHD exchange-code
-- suffix, and per-market liquidity thresholds (EGX's are EGP-denominated,
-- a US market's are USD, so these can't share one flat env var). `active`
-- controls whether the daily master workflow's schedule triggers include
-- this market; a market can exist here (and be run manually / shown in
-- the dashboard) before it has its own automatic daily schedule wired up
-- in n8n — adding a market via the future Settings UI doesn't by itself
-- create a new Schedule Trigger node, that's still a one-time n8n step.
-- `stocks.exchange` values are expected to match a `markets.code` here,
-- but that's not an FK: seeding order (this table is empty until
-- 004-seed-settings.sql, but `stocks` rows only start existing once an
-- n8n run populates them, well after seeding) makes enforcing it more
-- trouble than it's worth for a two-market start.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS markets (
    code                  VARCHAR(16) PRIMARY KEY,
    name                  VARCHAR(64) NOT NULL,
    currency              VARCHAR(8) NOT NULL,
    timezone              VARCHAR(64) NOT NULL,
    eodhd_exchange_code   VARCHAR(16) NOT NULL,
    index_code            VARCHAR(32),
    min_avg_traded_value  NUMERIC,
    min_avg_volume        NUMERIC,
    min_active_days_20    INTEGER,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Minimum meaningful Target-1 distance (% above entry). Workflow 11 skips
    -- any resistance level closer than this when deriving targets, and the
    -- outcome statistics (workflow 16 probability_stats, GET /outcomes)
    -- ignore picks whose T1 is below it. Added 2026-08-30 after the scoring
    -- calibration incident: a resistance 0.3% away counts as a "hit" ~80% of
    -- the time, which let the ranking game the hit-rate metric with
    -- worthless targets. Seeded per market in 004-seed-settings.sql.
    min_target_gain_pct   NUMERIC(5,2) NOT NULL DEFAULT 2.00
);

COMMENT ON TABLE markets IS 'Multi-market configuration: one row per market the pipeline can scan (currency, timezone, EODHD exchange code, per-market liquidity thresholds). Seeded in 004-seed-settings.sql.';
COMMENT ON COLUMN markets.active IS 'Whether this market has an automatic daily Schedule Trigger in 12-egx-daily-master-workflow — not the same as "exists and is manually runnable", which any row here already is.';

-- ---------------------------------------------------------------------
-- daily_prices: OHLCV history per stock
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_prices (
    id                  BIGSERIAL PRIMARY KEY,
    stock_id            BIGINT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    trading_date        DATE   NOT NULL,
    open                NUMERIC(18,6) NOT NULL,
    high                NUMERIC(18,6) NOT NULL,
    low                 NUMERIC(18,6) NOT NULL,
    close               NUMERIC(18,6) NOT NULL,
    adjusted_close      NUMERIC(18,6),
    volume              BIGINT NOT NULL DEFAULT 0,
    traded_value        NUMERIC(20,4),
    number_of_trades    INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_daily_prices_stock_date UNIQUE (stock_id, trading_date),
    CONSTRAINT ck_daily_prices_ohlc CHECK (
        high >= open AND high >= close AND high >= low
        AND low <= open AND low <= close
        AND volume >= 0 AND close > 0
    )
);

COMMENT ON TABLE daily_prices IS 'Daily OHLCV candles, one row per stock per trading session';

-- ---------------------------------------------------------------------
-- technical_analysis: calculated indicators per stock/date
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS technical_analysis (
    id                      BIGSERIAL PRIMARY KEY,
    stock_id                BIGINT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    trading_date            DATE   NOT NULL,

    sma20                   NUMERIC(18,6),
    sma50                   NUMERIC(18,6),
    sma100                  NUMERIC(18,6),
    sma200                  NUMERIC(18,6),

    ema9                    NUMERIC(18,6),
    ema20                   NUMERIC(18,6),
    ema50                   NUMERIC(18,6),
    ema100                  NUMERIC(18,6),
    ema200                  NUMERIC(18,6),

    rsi14                   NUMERIC(8,4),

    macd                    NUMERIC(18,6),
    macd_signal              NUMERIC(18,6),
    macd_histogram          NUMERIC(18,6),

    atr14                   NUMERIC(18,6),

    obv                     NUMERIC(24,4),

    volume_sma20            NUMERIC(20,4),
    volume_sma50            NUMERIC(20,4),

    relative_volume20       NUMERIC(10,4),
    relative_volume50       NUMERIC(10,4),

    roc5                    NUMERIC(10,4),
    roc10                   NUMERIC(10,4),
    roc20                   NUMERIC(10,4),

    high20                  NUMERIC(18,6),
    high50                  NUMERIC(18,6),
    high252                 NUMERIC(18,6),

    low20                   NUMERIC(18,6),
    low50                   NUMERIC(18,6),
    low252                  NUMERIC(18,6),

    distance_52w_high       NUMERIC(10,4),
    distance_52w_low        NUMERIC(10,4),

    short_term_trend        VARCHAR(20),
    medium_term_trend       VARCHAR(20),
    long_term_trend         VARCHAR(20),

    data_confidence         NUMERIC(6,2),

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_technical_analysis_stock_date UNIQUE (stock_id, trading_date)
);

COMMENT ON TABLE technical_analysis IS 'Per-stock daily technical indicator snapshot';

-- ---------------------------------------------------------------------
-- support_resistance: computed structure levels per stock/date
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_resistance (
    id                              BIGSERIAL PRIMARY KEY,
    stock_id                        BIGINT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    trading_date                    DATE   NOT NULL,

    support1                        NUMERIC(18,6),
    support2                        NUMERIC(18,6),
    support3                        NUMERIC(18,6),

    resistance1                     NUMERIC(18,6),
    resistance2                     NUMERIC(18,6),
    resistance3                     NUMERIC(18,6),

    support1_strength               NUMERIC(6,2),
    support2_strength               NUMERIC(6,2),
    support3_strength               NUMERIC(6,2),

    resistance1_strength            NUMERIC(6,2),
    resistance2_strength            NUMERIC(6,2),
    resistance3_strength            NUMERIC(6,2),

    nearest_support_distance_pct    NUMERIC(10,4),
    nearest_resistance_distance_pct NUMERIC(10,4),

    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_support_resistance_stock_date UNIQUE (stock_id, trading_date)
);

COMMENT ON TABLE support_resistance IS 'Clustered swing-based support/resistance levels';

-- ---------------------------------------------------------------------
-- volume_analysis: cross-sectional volume metrics + accumulation signal
-- Populated by 06-egx-volume-analysis; read by the 07-10 scanners and by
-- 11-egx-overall-ranking so they don't each recompute market-wide rankings.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS volume_analysis (
    id                          BIGSERIAL PRIMARY KEY,
    stock_id                    BIGINT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    trading_date                DATE   NOT NULL,

    volume_change_1d_pct        NUMERIC(10,4),
    volume_change_vs_20d_pct    NUMERIC(10,4),
    volume_change_vs_50d_pct    NUMERIC(10,4),

    volume_rank                 INTEGER,
    traded_value_rank           INTEGER,
    relative_volume20_rank      INTEGER,
    relative_volume50_rank      INTEGER,

    accumulation_score          NUMERIC(6,2),

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_volume_analysis_stock_date UNIQUE (stock_id, trading_date)
);

COMMENT ON TABLE volume_analysis IS 'Cross-sectional volume rankings + accumulation score per stock per trading date';

-- ---------------------------------------------------------------------
-- scanner_runs: one row per daily/backtest scan execution
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scanner_runs (
    id                  BIGSERIAL PRIMARY KEY,
    trading_date        DATE NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    stocks_scanned      INTEGER NOT NULL DEFAULT 0,
    eligible_stocks     INTEGER NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
                            CHECK (status IN ('RUNNING','COMPLETED','FAILED','PARTIAL')),
    market_score        NUMERIC(6,2),
    market_regime       VARCHAR(20),
    run_type            VARCHAR(20) NOT NULL DEFAULT 'LIVE'
                            CHECK (run_type IN ('LIVE','BACKTEST','MANUAL')),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    market              VARCHAR(16) NOT NULL DEFAULT 'EGX',
    CONSTRAINT uq_scanner_runs_date_type UNIQUE (trading_date, run_type, market)
);

COMMENT ON TABLE scanner_runs IS 'One record per scanner execution (daily live run or backtest step), scoped to one market';

-- CREATE TABLE IF NOT EXISTS above is a no-op against an existing database
-- (see the ai_stop_probability_pct precedent above for why) — these apply
-- the market column and widen the uniqueness constraint on any database
-- that already has scanner_runs from before multi-market support. Every
-- workflow (07-11) that does "INSERT ... ON CONFLICT (trading_date,
-- run_type) DO UPDATE" to get-or-create a scanner_run must be updated to
-- match the new 3-column conflict target, or those upserts start failing
-- with "no unique or exclusion constraint matching the ON CONFLICT
-- specification" the moment this constraint changes underneath them.
-- Must run BEFORE the COMMENT ON COLUMN below — that requires the column
-- to already exist (confirmed live: the original ordering here failed
-- with "column market of relation scanner_runs does not exist", same
-- mistake as the ai_stop_probability_pct column earlier this session).
ALTER TABLE scanner_runs ADD COLUMN IF NOT EXISTS market VARCHAR(16) NOT NULL DEFAULT 'EGX';
ALTER TABLE scanner_runs DROP CONSTRAINT IF EXISTS uq_scanner_runs_date_type;
ALTER TABLE scanner_runs ADD CONSTRAINT uq_scanner_runs_date_type UNIQUE (trading_date, run_type, market);

COMMENT ON COLUMN scanner_runs.market IS 'References markets.code (not an FK — see markets table comment). A LIVE run for the same trading_date exists once per market, not once globally.';

-- ---------------------------------------------------------------------
-- scanner_results: ranked output per stock per scanner_run
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scanner_results (
    id                      BIGSERIAL PRIMARY KEY,
    scanner_run_id          BIGINT NOT NULL REFERENCES scanner_runs(id) ON DELETE CASCADE,
    stock_id                BIGINT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,

    overall_rank            INTEGER,

    overall_score            NUMERIC(6,2) NOT NULL DEFAULT 0,
    breakout_score           NUMERIC(6,2) NOT NULL DEFAULT 0,
    momentum_score           NUMERIC(6,2) NOT NULL DEFAULT 0,
    pullback_score           NUMERIC(6,2) NOT NULL DEFAULT 0,
    reversal_score           NUMERIC(6,2) NOT NULL DEFAULT 0,
    accumulation_score       NUMERIC(6,2) NOT NULL DEFAULT 0,
    volume_score             NUMERIC(6,2) NOT NULL DEFAULT 0,
    trend_score              NUMERIC(6,2) NOT NULL DEFAULT 0,
    risk_reward_score        NUMERIC(6,2) NOT NULL DEFAULT 0,

    setup_type               VARCHAR(20) NOT NULL DEFAULT 'NEUTRAL'
                                CHECK (setup_type IN
                                    ('BREAKOUT','MOMENTUM','PULLBACK','REVERSAL',
                                     'ACCUMULATION','NEUTRAL','AVOID')),

    eligible                 BOOLEAN NOT NULL DEFAULT TRUE,
    eligibility_reason       VARCHAR(255),

    data_confidence          NUMERIC(6,2),
    setup_confidence         NUMERIC(6,2),

    entry_price               NUMERIC(18,6),
    invalidation_price         NUMERIC(18,6),
    target1                   NUMERIC(18,6),
    target2                   NUMERIC(18,6),
    target3                   NUMERIC(18,6),

    risk_reward_t1            NUMERIC(10,4),
    risk_reward_t2            NUMERIC(10,4),
    risk_reward_t3            NUMERIC(10,4),

    -- Potential gain (%) from entry to each target IF reached — plain
    -- arithmetic on real prices, not a forecast. estimated_days is a rough
    -- ATR-based projection (distance ÷ half the stock's own average daily
    -- range), not a historical statistic or a guarantee — see
    -- code/riskReward.js and docs/SCORING.md for the exact method and its
    -- honesty caveats.
    target1_gain_pct          NUMERIC(10,4),
    target2_gain_pct          NUMERIC(10,4),
    target3_gain_pct          NUMERIC(10,4),
    target1_estimated_days    INTEGER,
    target2_estimated_days    INTEGER,
    target3_estimated_days    INTEGER,

    reasons_json              JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings_json              JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- AI Assessment (user-requested addition beyond the original spec):
    -- a language model's qualitative read of the Top 10's technical setups,
    -- populated only for overall_rank <= 10 AND eligible rows by
    -- 17-egx-ai-assessment. Deliberately separate from, and never mixed
    -- into, overall_score or historical_target1_hit_pct — those are a
    -- deterministic formula and a measured historical rate respectively;
    -- this is a model's judgment call, labeled as such everywhere it's
    -- surfaced (see docs/SCORING.md "AI Assessment").
    ai_target1_probability_pct NUMERIC(6,2),
    ai_stop_probability_pct    NUMERIC(6,2),
    ai_rank_score              NUMERIC(6,2),
    ai_rank                    INTEGER,
    ai_reasoning               TEXT,
    ai_assessed_at             TIMESTAMPTZ,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_scanner_results_run_stock UNIQUE (scanner_run_id, stock_id)
);

COMMENT ON TABLE scanner_results IS 'Per-stock scoring output for a given scanner_run';

-- CREATE TABLE IF NOT EXISTS above is a no-op on any database where
-- scanner_results already existed before this AI Assessment addition — it
-- does NOT retroactively add new columns to an existing table. These
-- ALTER statements are what actually apply the columns anywhere except a
-- genuinely fresh install (confirmed via live testing: the CREATE TABLE
-- alone failed with "column ... does not exist" against the existing dev
-- database when 003-views.sql's updated view tried to select them). Must
-- run BEFORE the COMMENT ON COLUMN statements below — those require the
-- column to already exist (also confirmed via live testing: the original
-- ordering here failed the same way, just one statement type sooner).
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS ai_target1_probability_pct NUMERIC(6,2);
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS ai_stop_probability_pct NUMERIC(6,2);
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS ai_rank_score NUMERIC(6,2);
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS ai_rank INTEGER;
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS ai_assessed_at TIMESTAMPTZ;

COMMENT ON COLUMN scanner_results.ai_target1_probability_pct IS 'AI Assessment: a language model''s own probability estimate (0-100) for reaching target1 within target1_estimated_days — NOT the measured historical_target1_hit_pct, and NOT a guarantee.';
COMMENT ON COLUMN scanner_results.ai_stop_probability_pct IS 'AI Assessment: a language model''s own probability estimate (0-100) that the invalidation/stop price is hit before target1 — NOT the measured historical_stop_hit_pct, and NOT a guarantee.';
COMMENT ON COLUMN scanner_results.ai_rank_score IS 'AI Assessment: 0-100 conviction score used to derive ai_rank; independent of overall_score.';
COMMENT ON COLUMN scanner_results.ai_rank IS 'Rank (1=highest) among that day''s Top 10 by ai_rank_score — a second, AI-driven ordering shown alongside overall_rank, not a replacement for it.';

-- ---------------------------------------------------------------------
-- prediction_evaluation: forward-looking evaluation of scanner_results
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prediction_evaluation (
    id                                      BIGSERIAL PRIMARY KEY,
    scanner_result_id                       BIGINT NOT NULL REFERENCES scanner_results(id) ON DELETE CASCADE,

    next_trading_date                       DATE,
    next_open                               NUMERIC(18,6),
    next_high                               NUMERIC(18,6),
    next_low                                NUMERIC(18,6),
    next_close                              NUMERIC(18,6),

    return_open_to_close_pct                NUMERIC(10,4),
    return_previous_close_to_close_pct      NUMERIC(10,4),
    maximum_favorable_excursion_pct         NUMERIC(10,4),
    maximum_adverse_excursion_pct           NUMERIC(10,4),

    target1_hit                             BOOLEAN,
    target2_hit                             BOOLEAN,
    target3_hit                             BOOLEAN,
    stop_hit                                BOOLEAN,

    success                                 BOOLEAN,

    evaluated_at                            TIMESTAMPTZ,
    created_at                              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_prediction_evaluation_result UNIQUE (scanner_result_id)
);

COMMENT ON TABLE prediction_evaluation IS 'Next-session outcome evaluation for a scanner_results row';

-- ---------------------------------------------------------------------
-- range_forecast: next-session High/Low projection + backtested accuracy
-- (user-requested addition). next_high_estimate/next_low_estimate use a
-- simple, transparent ATR-based band (close +/- 1x ATR14) for the NEXT
-- trading session — not a guarantee. accuracy_pct is a real backtested
-- containment rate: walking this stock's own history, on what % of past
-- sessions did the ACTUAL next-session high/low both fall inside the
-- band that this same formula would have predicted the day before? A
-- deliberately honest per-stock measure (not tuned to look good) rather
-- than a single project-wide constant — see 18-egx-range-forecast.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS range_forecast (
    id                  BIGSERIAL PRIMARY KEY,
    stock_id            BIGINT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    trading_date        DATE NOT NULL,
    close               NUMERIC(18,6),
    next_high_estimate  NUMERIC(18,6),
    next_low_estimate   NUMERIC(18,6),
    accuracy_pct        NUMERIC(6,2),
    sample_size         INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_range_forecast_stock_date UNIQUE (stock_id, trading_date)
);

COMMENT ON TABLE range_forecast IS 'Next-session High/Low estimate (close +/- 1x ATR14) plus a backtested per-stock containment-rate accuracy, one row per stock per trading date';

-- ---------------------------------------------------------------------
-- scoring_weights: configurable weighting for overall_score composition
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scoring_weights (
    id              BIGSERIAL PRIMARY KEY,
    profile_name    VARCHAR(64) NOT NULL DEFAULT 'default',
    factor          VARCHAR(64) NOT NULL,
    weight          NUMERIC(6,2) NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_scoring_weights_profile_factor UNIQUE (profile_name, factor)
);

COMMENT ON TABLE scoring_weights IS 'Configurable weights consumed by code/overallScore.js';

-- ---------------------------------------------------------------------
-- app_settings: generic key/value runtime configuration (non-secret)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
    key             VARCHAR(128) PRIMARY KEY,
    value           JSONB NOT NULL,
    description     VARCHAR(255),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_settings IS 'Non-secret runtime configuration overridable without redeploying workflows';

-- ---------------------------------------------------------------------
-- workflow_errors: captured per-symbol / per-workflow failures
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_errors (
    id              BIGSERIAL PRIMARY KEY,
    workflow_name   VARCHAR(128) NOT NULL,
    symbol          VARCHAR(32),
    trading_date    DATE,
    error_message   TEXT NOT NULL,
    payload         JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE workflow_errors IS 'Non-fatal per-item errors captured during workflow execution';

-- ---------------------------------------------------------------------
-- index_prices: optional EGX30 (or other) index history for market regime
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS index_prices (
    id              BIGSERIAL PRIMARY KEY,
    index_code      VARCHAR(32) NOT NULL DEFAULT 'EGX30',
    trading_date    DATE NOT NULL,
    open            NUMERIC(18,6),
    high            NUMERIC(18,6),
    low             NUMERIC(18,6),
    close           NUMERIC(18,6),
    volume          BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_index_prices_code_date UNIQUE (index_code, trading_date)
);

COMMENT ON TABLE index_prices IS 'Optional broad-market index history (e.g. EGX30) for market regime analysis';

-- ---------------------------------------------------------------------
-- Historical probability tracking (user-requested addition beyond the
-- original spec): "what % of past picks like this actually reached
-- Target 1 within their estimated days, vs hit the stop first?"
--
-- Deliberately separate from prediction_evaluation (which only looks at
-- the SINGLE next trading session). This tracks the FULL window out to
-- each pick's own target1_estimated_days, since that's the actual
-- question being asked — not just "did it move favorably tomorrow."
-- Populated by 16-egx-target-window-evaluation. Tables live here (not a
-- later-numbered file) because 003-views.sql's v_scanner_top/
-- v_full_market join probability_stats, so it must exist before those
-- views are created.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS target_window_evaluation (
    id                      BIGSERIAL PRIMARY KEY,
    scanner_result_id       BIGINT NOT NULL REFERENCES scanner_results(id) ON DELETE CASCADE,
    target1_estimated_days  INTEGER NOT NULL,
    outcome                 VARCHAR(20) NOT NULL,
    resolved_day_number     INTEGER,
    evaluated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_target_window_evaluation_result UNIQUE (scanner_result_id),
    CONSTRAINT chk_target_window_evaluation_outcome
        CHECK (outcome IN ('TARGET1_HIT', 'STOP_HIT', 'EXPIRED_NO_HIT'))
);

COMMENT ON TABLE target_window_evaluation IS 'Per-pick outcome walking forward up to target1_estimated_days trading sessions: did price reach target1 first, hit the invalidation/stop level first, or neither within the window?';
COMMENT ON COLUMN target_window_evaluation.outcome IS 'TARGET1_HIT: high touched target1 before invalidation, within the window. STOP_HIT: invalidation touched first (or same day as target1 — ambiguous intraday order, treated conservatively as a stop, matching prediction_evaluation.success convention). EXPIRED_NO_HIT: neither triggered by the time target1_estimated_days sessions had elapsed.';
COMMENT ON COLUMN target_window_evaluation.resolved_day_number IS 'Which trading day (1-indexed from the scan date) the outcome resolved on; NULL for EXPIRED_NO_HIT.';

CREATE TABLE IF NOT EXISTS probability_stats (
    setup_type          VARCHAR(20) NOT NULL,
    market              VARCHAR(16) NOT NULL DEFAULT 'EGX',
    sample_size         INTEGER NOT NULL,
    target1_hit_pct     NUMERIC(6,2) NOT NULL,
    stop_hit_pct        NUMERIC(6,2) NOT NULL,
    expired_no_hit_pct  NUMERIC(6,2) NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_probability_stats PRIMARY KEY (setup_type, market)
);

COMMENT ON TABLE probability_stats IS 'Historical, per-setup-type-per-market outcome rates from target_window_evaluation — NOT a forecast, a measured track record over whatever data has accumulated so far (see sample_size). A setup type''s base rate is tracked separately per market: EGX MOMENTUM picks and US MOMENTUM picks do not share a hit rate.';

-- CREATE TABLE IF NOT EXISTS above is a no-op against an existing
-- database — this applies the market column and widens the primary key
-- on any database that already has probability_stats from before
-- multi-market support (same pattern as scanner_runs above). Dropping and
-- re-adding a PRIMARY KEY (rather than a plain named UNIQUE constraint)
-- needs its auto-generated name looked up first, since Postgres names it
-- "probability_stats_pkey" by default on a fresh install but this ALTER
-- can't assume that name wasn't already replaced by an earlier version of
-- this same migration running twice.
ALTER TABLE probability_stats ADD COLUMN IF NOT EXISTS market VARCHAR(16) NOT NULL DEFAULT 'EGX';
DO $$
DECLARE pk_name text;
BEGIN
  SELECT tc.constraint_name INTO pk_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_name = 'probability_stats' AND tc.constraint_type = 'PRIMARY KEY';
  IF pk_name IS NOT NULL AND pk_name != 'pk_probability_stats' THEN
    EXECUTE format('ALTER TABLE probability_stats DROP CONSTRAINT %I', pk_name);
    pk_name := NULL;
  END IF;
  IF pk_name IS NULL THEN
    ALTER TABLE probability_stats ADD CONSTRAINT pk_probability_stats PRIMARY KEY (setup_type, market);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Horizon estimates (2026-09-01): drift + volatility projection per
-- stock/date (the standard "expected move" framework: mu/sigma of daily
-- log returns over the trailing 252 sessions, >=60 returns required).
-- est_*_pct = (e^(mu*h) - 1) * 100 for h = 10/21/63/252 trading days.
-- A projection of the stock's own measured history — not a forecast.
-- ---------------------------------------------------------------------
ALTER TABLE technical_analysis ADD COLUMN IF NOT EXISTS drift_annual_pct      NUMERIC(12,4);
ALTER TABLE technical_analysis ADD COLUMN IF NOT EXISTS volatility_annual_pct NUMERIC(12,4);
ALTER TABLE technical_analysis ADD COLUMN IF NOT EXISTS est_2w_pct            NUMERIC(12,4);
ALTER TABLE technical_analysis ADD COLUMN IF NOT EXISTS est_1m_pct            NUMERIC(12,4);
ALTER TABLE technical_analysis ADD COLUMN IF NOT EXISTS est_3m_pct            NUMERIC(12,4);
ALTER TABLE technical_analysis ADD COLUMN IF NOT EXISTS est_1y_pct            NUMERIC(12,4);
