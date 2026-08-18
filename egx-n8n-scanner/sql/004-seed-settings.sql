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
