-- scoring-lab Inputs query (n8n Postgres node, "Inputs" step of the ZZ Scoring Lab
-- helper). Feeds scripts/scoring-lab.js runLab(rows, candles, params); the Candles
-- step is a plain SELECT stock_id, trading_date::text AS d, high, low, close FROM
-- daily_prices for the same market/date range. {{ $(...) }} are n8n expressions —
-- the market comes from the Params node. Column names must match runLab numCols.
-- 2026-09-02: market_score (run-level) added for the minMarketScore regime gate.
WITH runs AS (
  SELECT id AS run_id, trading_date, run_type, market_score FROM scanner_runs
  WHERE market = '{{ $('Params').first().json.market }}' AND run_type IN ('LIVE','BACKTEST')
),
px AS (
  SELECT dp.stock_id, dp.trading_date, dp.close, dp.high, dp.low,
         AVG(dp.volume) OVER w AS avg_volume20,
         AVG(dp.traded_value) OVER w AS avg_traded_value20,
         SUM(CASE WHEN dp.volume > 0 THEN 1 ELSE 0 END) OVER w AS active_days20,
         LAG(dp.close, 20) OVER (PARTITION BY dp.stock_id ORDER BY dp.trading_date) AS close20d_ago
  FROM daily_prices dp JOIN stocks s ON s.id = dp.stock_id
  WHERE s.exchange = '{{ $('Params').first().json.market }}' AND dp.trading_date >= '2026-03-01'
  WINDOW w AS (PARTITION BY dp.stock_id ORDER BY dp.trading_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
),
rsi AS (
  SELECT ta.stock_id, ta.trading_date,
         LAG(ta.rsi14, 3) OVER (PARTITION BY ta.stock_id ORDER BY ta.trading_date) AS rsi14_3d_ago
  FROM technical_analysis ta JOIN stocks s ON s.id = ta.stock_id
  WHERE s.exchange = '{{ $('Params').first().json.market }}' AND ta.trading_date >= '2026-03-01'
)
SELECT r.trading_date::text AS d, r.run_type, r.market_score::float8 AS market_score, sr.stock_id, s.symbol,
  px.close::float8 AS close, px.high::float8 AS high, px.low::float8 AS low,
  px.avg_volume20::float8 AS avg_volume20, px.avg_traded_value20::float8 AS avg_traded_value20,
  px.active_days20::float8 AS active_days20, px.close20d_ago::float8 AS close20d_ago,
  ta.atr14::float8 AS atr14, ta.data_confidence::float8 AS data_confidence, ta.macd_histogram::float8 AS macd_histogram,
  ta.relative_volume20::float8 AS relative_volume20, ta.medium_term_trend, ta.rsi14::float8 AS rsi14, ta.ema20::float8 AS ema20,
  rsi.rsi14_3d_ago::float8 AS rsi14_3d_ago,
  x.resistance1::float8 AS resistance1, x.resistance2::float8 AS resistance2, x.resistance3::float8 AS resistance3,
  x.support1::float8 AS support1, x.support2::float8 AS support2, x.support3::float8 AS support3,
  x.nearest_resistance_distance_pct::float8 AS nearest_resistance_distance_pct,
  x.nearest_support_distance_pct::float8 AS nearest_support_distance_pct,
  va.accumulation_score::float8 AS accumulation_score,
  sr.breakout_score::float8 AS breakout_score, sr.momentum_score::float8 AS momentum_score,
  sr.pullback_score::float8 AS pullback_score, sr.reversal_score::float8 AS reversal_score,
  sr.overall_score::float8 AS stored_score, sr.overall_rank AS stored_rank, sr.setup_type AS stored_setup
FROM runs r
JOIN scanner_results sr ON sr.scanner_run_id = r.run_id
JOIN stocks s ON s.id = sr.stock_id
LEFT JOIN px ON px.stock_id = sr.stock_id AND px.trading_date = r.trading_date
LEFT JOIN rsi ON rsi.stock_id = sr.stock_id AND rsi.trading_date = r.trading_date
LEFT JOIN technical_analysis ta ON ta.stock_id = sr.stock_id AND ta.trading_date = r.trading_date
LEFT JOIN support_resistance x ON x.stock_id = sr.stock_id AND x.trading_date = r.trading_date
LEFT JOIN volume_analysis va ON va.stock_id = sr.stock_id AND va.trading_date = r.trading_date
ORDER BY r.trading_date, sr.stock_id;
