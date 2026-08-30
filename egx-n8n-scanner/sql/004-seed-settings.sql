-- =====================================================================
-- EGX N8N Scanner - Seed data (scoring weights + app settings)
-- Run after 003-views.sql
-- Safe to re-run: uses ON CONFLICT upserts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Default overall_score weights (section 21). Sum = 100.
-- Read by code/overallScore.js via a Postgres node in the ranking workflow.
-- ---------------------------------------------------------------------
INSERT INTO scoring_weights (profile_name, factor, weight, active) VALUES
    ('default', 'trend',              20, TRUE),
    ('default', 'volume',             20, TRUE),
    ('default', 'momentum',           15, TRUE),
    ('default', 'breakout',           15, TRUE),
    ('default', 'price_structure',    10, TRUE),
    ('default', 'macd',                5, TRUE),
    ('default', 'rsi',                 5, TRUE),
    ('default', 'relative_strength',   5, TRUE),
    ('default', 'risk_reward',         5, TRUE)
ON CONFLICT (profile_name, factor) DO UPDATE
    SET weight = EXCLUDED.weight, active = EXCLUDED.active, updated_at = now();

-- ---------------------------------------------------------------------
-- Multi-market configuration (user-requested addition beyond the original
-- single-market/EGX spec). EGX's values match the existing MIN_AVG_*/
-- EGX_EXCHANGE_CODE env vars exactly — this seed doesn't change EGX's
-- live behavior, just moves what was a flat env var into a per-market row
-- so a second market can have its own, genuinely different, thresholds.
--
-- US is a starting point, not a measured/tuned value: liquid enough to
-- filter out illiquid names without restricting to only mega-caps, in the
-- same spirit as EGX's thresholds — tune via a future Settings UI once
-- real scan data exists to judge against. eodhd_exchange_code 'US' is
-- EODHD's combined NYSE+Nasdaq feed (see docs/DATA_PROVIDER.md); index_code
-- 'GSPC' (S&P 500) is a placeholder representative broad-market index —
-- confirm the exact ticker your provider expects, same CONFIGURE-ENDPOINT
-- spirit as the HTTP Request node URLs elsewhere in this project.
-- ---------------------------------------------------------------------
INSERT INTO markets (code, name, currency, timezone, eodhd_exchange_code, index_code, min_avg_traded_value, min_avg_volume, min_active_days_20, active, min_target_gain_pct) VALUES
    ('EGX', 'Egyptian Exchange',  'EGP', 'Africa/Cairo',    'EGX', 'EGX30', 500000,   50000,  15, TRUE, 2.00),
    ('US',  'US Market (Nasdaq/NYSE)', 'USD', 'America/New_York', 'US',  'GSPC',  1000000, 300000, 15, TRUE, 1.50)
ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name, currency = EXCLUDED.currency, timezone = EXCLUDED.timezone,
        eodhd_exchange_code = EXCLUDED.eodhd_exchange_code, index_code = EXCLUDED.index_code,
        min_avg_traded_value = EXCLUDED.min_avg_traded_value, min_avg_volume = EXCLUDED.min_avg_volume,
        min_active_days_20 = EXCLUDED.min_active_days_20,
        min_target_gain_pct = EXCLUDED.min_target_gain_pct;
-- US is now active = TRUE: Phase 3 added its automatic daily Schedule
-- Trigger to workflow 12 (retry-import window in 03, main scan ~03:00
-- Africa/Cairo the day after each US session). `active` here means "has
-- an automatic daily Schedule Trigger in 12" (see markets.active comment
-- in 001-schema.sql). This INSERT's ON CONFLICT clause deliberately
-- excludes `active` from its SET list, so re-running this seed never
-- reverts a market's live active flag back to this default.

-- ---------------------------------------------------------------------
-- Non-secret runtime settings. Secrets (API keys, DB credentials, webhook
-- bearer tokens) live ONLY in .env / n8n credentials, never here.
-- ---------------------------------------------------------------------
INSERT INTO app_settings (key, value, description) VALUES
    ('top_n', '10', 'Number of stocks to include in each Top-N ranked list'),
    ('breakout_min_rvol', '1.5', 'Minimum RVOL20 to qualify for BREAKOUT_WATCH'),
    ('breakout_strong_rvol', '2', 'RVOL20 threshold considered a strong breakout signal'),
    ('breakout_distance_pct', '1.5', 'Max % distance below resistance to qualify as breakout watch'),
    ('support_resistance_lookback', '150', 'Number of trading sessions analyzed for swing detection'),
    ('min_active_days_20', '15', 'Minimum number of traded (non-zero-volume) sessions in the last 20 for liquidity eligibility'),
    ('market_regime_thresholds', '{"strong_bullish":75,"bullish":60,"neutral":40,"bearish":25}', 'market_score cut points used to classify market_regime')
ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now();
