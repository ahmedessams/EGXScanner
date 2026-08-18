-- =====================================================================
-- EGX N8N Scanner - Indexes
-- Run after 001-schema.sql
-- =====================================================================

-- stocks -----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_stocks_active ON stocks (active);
CREATE INDEX IF NOT EXISTS idx_stocks_sector ON stocks (sector);
CREATE INDEX IF NOT EXISTS idx_stocks_symbol ON stocks (symbol);

-- daily_prices -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_daily_prices_stock_date
    ON daily_prices (stock_id, trading_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_prices_date
    ON daily_prices (trading_date);
CREATE INDEX IF NOT EXISTS idx_daily_prices_volume
    ON daily_prices (trading_date, volume DESC);
CREATE INDEX IF NOT EXISTS idx_daily_prices_traded_value
    ON daily_prices (trading_date, traded_value DESC);

-- technical_analysis ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_technical_analysis_date
    ON technical_analysis (trading_date);
CREATE INDEX IF NOT EXISTS idx_technical_analysis_stock_date
    ON technical_analysis (stock_id, trading_date DESC);
CREATE INDEX IF NOT EXISTS idx_technical_analysis_rvol20
    ON technical_analysis (trading_date, relative_volume20 DESC);

-- support_resistance ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_support_resistance_stock_date
    ON support_resistance (stock_id, trading_date DESC);

-- volume_analysis ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_volume_analysis_stock_date
    ON volume_analysis (stock_id, trading_date DESC);
CREATE INDEX IF NOT EXISTS idx_volume_analysis_date
    ON volume_analysis (trading_date);
CREATE INDEX IF NOT EXISTS idx_volume_analysis_rvol20_rank
    ON volume_analysis (trading_date, relative_volume20_rank);

-- scanner_runs -----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_scanner_runs_date
    ON scanner_runs (trading_date DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_runs_status
    ON scanner_runs (status);

-- scanner_results ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_scanner_results_run
    ON scanner_results (scanner_run_id);
CREATE INDEX IF NOT EXISTS idx_scanner_results_run_rank
    ON scanner_results (scanner_run_id, overall_rank);
CREATE INDEX IF NOT EXISTS idx_scanner_results_run_setup
    ON scanner_results (scanner_run_id, setup_type);
CREATE INDEX IF NOT EXISTS idx_scanner_results_run_score
    ON scanner_results (scanner_run_id, overall_score DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_results_stock
    ON scanner_results (stock_id);
CREATE INDEX IF NOT EXISTS idx_scanner_results_eligible
    ON scanner_results (scanner_run_id, eligible);

-- prediction_evaluation --------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_prediction_evaluation_result
    ON prediction_evaluation (scanner_result_id);
CREATE INDEX IF NOT EXISTS idx_prediction_evaluation_next_date
    ON prediction_evaluation (next_trading_date);

-- scoring_weights ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_scoring_weights_profile
    ON scoring_weights (profile_name, active);

-- workflow_errors ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_workflow_errors_workflow
    ON workflow_errors (workflow_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_errors_symbol
    ON workflow_errors (symbol);

-- index_prices ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_index_prices_code_date
    ON index_prices (index_code, trading_date DESC);
