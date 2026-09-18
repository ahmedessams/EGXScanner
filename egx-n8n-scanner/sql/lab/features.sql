-- ---------------------------------------------------------------------
-- lab_features: the state vector for the swap-engine confluence lab
-- (docs/SWAP-ENGINE-PLAN.md phase 1). One row per Top-30 pick, both
-- markets, BACKTEST + LIVE, 2021→now. 97 binary features packed into a
-- text bitstring (`bits`, position i = feature i in lab_feature_names) so
-- the whole table travels to an n8n Code node as ~50k short strings.
-- Labels: outcome (TARGET1_HIT / STOP_HIT / EXPIRED_NO_HIT / NULL = not yet
-- evaluated), realized_mtm (% of entry: T1 gain / −risk / close of the last
-- window day), realized_zero (expired = 0), ret_5d_pct, mfe_5d_pct.
-- Slices: TRAIN = BACKTEST < 2025-01-01, HOLDOUT = BACKTEST ≥ 2025-01-01,
-- LIVE. Scratch table: DROP when the lab is done. Thresholds come from the
-- 2024→ Top-30 distribution (docs/FEATURES.md).
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS lab_features;
DROP TABLE IF EXISTS lab_feature_names;

CREATE TABLE lab_feature_names (idx INT PRIMARY KEY, name TEXT NOT NULL, family TEXT NOT NULL);
INSERT INTO lab_feature_names VALUES
 (0,'above_ema20','technical'),(1,'above_ema50','technical'),(2,'above_sma200','technical'),(3,'ema_stack_20_50_200','technical'),
 (4,'rsi_ge60','technical'),(5,'rsi_ge70','technical'),(6,'rsi_lt50','technical'),(7,'macd_hist_pos','technical'),(8,'roc5_pos','technical'),
 (9,'roc20_above_median','technical'),(10,'roc20_top_quartile','technical'),(11,'near_52w_high_5pct','technical'),(12,'far_from_52w_high_20pct','technical'),
 (13,'close_at_high20','technical'),(14,'close_at_high50','technical'),(15,'rvol_ge1_5','volume'),(16,'rvol_ge2_5','volume'),(17,'rvol_lt1','volume'),
 (18,'rvol50_ge2','volume'),(19,'volatility_top_quartile','volatility'),(20,'volatility_bottom_quartile','volatility'),
 (21,'trend_mt_strong_bull','technical'),(22,'trend_lt_bull','technical'),(23,'trend_st_not_strong','technical'),(24,'lt_score_ge80','technical'),
 (25,'ichi_strong_bull','ichimoku'),(26,'ichi_not_bull','ichimoku'),(27,'above_tenkan','ichimoku'),(28,'above_kijun','ichimoku'),(29,'tk_bull_cross_state','ichimoku'),
 (30,'above_cloud','ichimoku'),(31,'cloud_dist_ge10','ichimoku'),(32,'cloud_dist_ge20','ichimoku'),(33,'cloud_bull_a_gt_b','ichimoku'),
 (34,'smc_bull_structure','smc'),(35,'smc_bos_up','smc'),(36,'smc_choch_up','smc'),(37,'smc_event_le3_bars','smc'),(38,'smc_sweep_low_le5','smc'),
 (39,'smc_sweep_high_le5','smc'),(40,'smc_in_bull_ob','smc'),(41,'smc_bull_fvg_within3pct','smc'),(42,'smc_premium','smc'),(43,'smc_discount','smc'),
 (44,'smc_range_pos_ge75','smc'),(45,'smc_bear_ob_present','smc'),
 (46,'setup_momentum','scanner'),(47,'setup_accumulation','scanner'),(48,'setup_pullback','scanner'),(49,'setup_other','scanner'),
 (50,'score_ge70','scanner'),(51,'score_ge80','scanner'),(52,'rank_le3','scanner'),(53,'rank_le10','scanner'),(54,'momentum_ge70','scanner'),
 (55,'accumulation_ge60','scanner'),(56,'setup_conf_ge60','scanner'),(57,'rr_t1_ge1','scanner'),(58,'est_days_le3','scanner'),(59,'est_days_le5','scanner'),
 (60,'t1_gain_ge5','scanner'),(61,'t1_gain_ge10','scanner'),(62,'rs20_pos','relative_strength'),(63,'rs20_ge10','relative_strength'),
 (64,'ext_ge2','extension'),(65,'ext_ge3','extension'),(66,'ext_lt1','extension'),(67,'close_pos_ge66','candle'),(68,'rsi_slope3_gt5','technical'),(69,'eq_v2_ge85','scanner'),
 (70,'resistance_within3pct','structure'),(71,'no_resistance_above','structure'),(72,'support_within3pct','structure'),
 (73,'vol_chg1d_ge50','volume'),(74,'vol_vs20_ge100','volume'),(75,'rvol_rank_le20','volume'),(76,'traded_value_rank_le30','liquidity'),
 (77,'market_score_ge60','regime'),(78,'market_score_lt40','regime'),(79,'regime_bull','regime'),(80,'index_ret20_pos','regime'),(81,'index_above_sma50','regime'),
 (82,'green_candle','candle'),(83,'marubozu_body60','candle'),(84,'gap_up_open_gt_prev_high','candle'),(85,'bull_engulfing','candle'),(86,'hammer','candle'),
 (87,'inside_bar','candle'),(88,'three_up_closes','candle'),(89,'range_expansion_1_5atr','volatility'),(90,'compression_10v30_lt50','volatility'),
 (91,'break_prev_week_high','structure'),(92,'break_prev_month_high','structure'),(93,'cmf20_pos','volume'),
 (94,'atv_tier1','liquidity'),(95,'atv_tier2','liquidity'),(96,'expired_prone_est_gt5','scanner');

CREATE TABLE lab_features AS
WITH base AS (
  SELECT sr.id AS sr_id, sr.stock_id, r.id AS run_id, r.market, r.run_type, r.trading_date AS d,
    CASE WHEN r.run_type = 'LIVE' THEN 'LIVE' WHEN r.trading_date < '2025-01-01' THEN 'TRAIN' ELSE 'HOLDOUT' END AS slice,
    sr.overall_rank, sr.overall_score, sr.setup_type, sr.setup_confidence,
    sr.breakout_score, sr.momentum_score, sr.pullback_score, sr.reversal_score, sr.accumulation_score,
    sr.entry_price AS e, sr.invalidation_price AS s, sr.target1 AS t1, GREATEST(COALESCE(sr.target1_estimated_days, 1), 1) AS w,
    sr.risk_reward_t1, sr.target1_gain_pct, sr.target1_estimated_days,
    sr.relative_strength_20d, sr.entry_quality_score, sr.extension_atr, sr.close_position_pct, sr.rsi_slope3,
    r.market_score, r.market_regime,
    ta.ema20, ta.ema50, ta.sma200, ta.ema200, ta.rsi14, ta.macd_histogram, ta.roc5, ta.roc20, ta.distance_52w_high, ta.high20, ta.high50,
    ta.relative_volume20, ta.relative_volume50, ta.volatility_annual_pct, ta.medium_term_trend, ta.long_term_trend, ta.short_term_trend, ta.long_term_score,
    ta.ichimoku_signal, ta.ichimoku_tenkan, ta.ichimoku_kijun, ta.ichimoku_cloud_dist_pct, ta.ichimoku_senkou_a, ta.ichimoku_senkou_b,
    ta.smc_structure, ta.smc_last_event, ta.smc_event_bars_ago, ta.smc_sweep, ta.smc_sweep_bars_ago, ta.smc_bull_ob_low, ta.smc_bull_ob_high,
    ta.smc_fvg_bull_high, ta.smc_fvg_bull_low, ta.smc_bias, ta.smc_range_pos_pct, ta.smc_bear_ob_low, ta.atr14,
    q.support1, q.resistance1, q.nearest_support_distance_pct, q.nearest_resistance_distance_pct,
    va.volume_change_1d_pct, va.volume_change_vs_20d_pct, va.relative_volume20_rank, va.traded_value_rank,
    twe.outcome, twe.ret_5d_pct, twe.mfe_5d_pct
  FROM scanner_results sr
  JOIN scanner_runs r ON r.id = sr.scanner_run_id
  JOIN technical_analysis ta ON ta.stock_id = sr.stock_id AND ta.trading_date = r.trading_date
  LEFT JOIN support_resistance q ON q.stock_id = sr.stock_id AND q.trading_date = r.trading_date
  LEFT JOIN volume_analysis va ON va.stock_id = sr.stock_id AND va.trading_date = r.trading_date
  LEFT JOIN target_window_evaluation twe ON twe.scanner_result_id = sr.id
  WHERE r.run_type IN ('BACKTEST','LIVE') AND r.status = 'COMPLETED' AND r.trading_date >= '2021-01-01'
    AND sr.overall_rank <= 30 AND sr.eligible
    AND sr.target1 IS NOT NULL AND sr.invalidation_price IS NOT NULL AND sr.entry_price > 0
    AND sr.target1 > sr.entry_price AND sr.invalidation_price < sr.entry_price
),
cnd AS (
  SELECT b.sr_id, c.*
  FROM base b CROSS JOIN LATERAL (
    SELECT
      max(open) FILTER (WHERE n = 1) AS o, max(high) FILTER (WHERE n = 1) AS h, max(low) FILTER (WHERE n = 1) AS l, max(close) FILTER (WHERE n = 1) AS c,
      max(open) FILTER (WHERE n = 2) AS o1, max(high) FILTER (WHERE n = 2) AS h1, max(low) FILTER (WHERE n = 2) AS l1, max(close) FILTER (WHERE n = 2) AS c1,
      max(close) FILTER (WHERE n = 3) AS c2, max(close) FILTER (WHERE n = 4) AS c3,
      max(high) FILTER (WHERE n BETWEEN 2 AND 6) AS prev_week_high,
      max(high) FILTER (WHERE n BETWEEN 2 AND 22) AS prev_month_high,
      max(high) FILTER (WHERE n <= 10) - min(low) FILTER (WHERE n <= 10) AS range10,
      max(high) FILTER (WHERE n <= 30) - min(low) FILTER (WHERE n <= 30) AS range30,
      SUM(CASE WHEN n <= 20 AND high > low THEN ((close - low) - (high - close)) / (high - low) * volume ELSE 0 END)
        / NULLIF(SUM(CASE WHEN n <= 20 THEN volume ELSE 0 END), 0) AS cmf20,
      AVG(traded_value) FILTER (WHERE n <= 20) AS atv20
    FROM (
      SELECT dp.open, dp.high, dp.low, dp.close, dp.volume, dp.traded_value, row_number() OVER (ORDER BY dp.trading_date DESC) AS n
      FROM daily_prices dp WHERE dp.stock_id = b.stock_id AND dp.trading_date <= b.d ORDER BY dp.trading_date DESC LIMIT 30
    ) x
  ) c
),
fwd AS (
  SELECT b.sr_id, (SELECT dp.close FROM daily_prices dp WHERE dp.stock_id = b.stock_id AND dp.trading_date > b.d ORDER BY dp.trading_date OFFSET b.w - 1 LIMIT 1) AS close_w
  FROM base b
),
idx AS (
  SELECT ip.trading_date AS d, m.code AS market, ip.close,
    ip.close / NULLIF(lag(ip.close, 20) OVER (PARTITION BY ip.index_code ORDER BY ip.trading_date), 0) - 1 AS ret20,
    AVG(ip.close) OVER (PARTITION BY ip.index_code ORDER BY ip.trading_date ROWS BETWEEN 49 PRECEDING AND CURRENT ROW) AS sma50
  FROM index_prices ip JOIN markets m ON m.index_code = ip.index_code
),
f AS (
  SELECT b.*, c.o, c.h, c.l, c.c, c.o1, c.h1, c.l1, c.c1, c.c2, c.c3, c.prev_week_high, c.prev_month_high, c.range10, c.range30, c.cmf20, c.atv20,
    fw.close_w, i.ret20 AS idx_ret20, i.close AS idx_close, i.sma50 AS idx_sma50,
    (b.t1 - b.e) / b.e * 100 AS g, (b.e - b.s) / b.e * 100 AS rk
  FROM base b JOIN cnd c ON c.sr_id = b.sr_id JOIN fwd fw ON fw.sr_id = b.sr_id
  LEFT JOIN idx i ON i.market = b.market AND i.d = b.d
)
SELECT sr_id, stock_id, run_id, market, run_type, slice, d, overall_rank, overall_score, setup_type,
  extension_atr, relative_volume20, market_score, outcome, ret_5d_pct, mfe_5d_pct, g AS t1_gain_pct, rk AS risk_pct, atv20,
  CASE outcome WHEN 'TARGET1_HIT' THEN g WHEN 'STOP_HIT' THEN -rk WHEN 'EXPIRED_NO_HIT' THEN (close_w - e) / e * 100 END AS realized_mtm,
  CASE outcome WHEN 'TARGET1_HIT' THEN g WHEN 'STOP_HIT' THEN -rk WHEN 'EXPIRED_NO_HIT' THEN 0 END AS realized_zero,
  -- array_to_string with null_string '0': a NULL input (missing indicator) is a 0 bit, never a dropped position.
  array_to_string(ARRAY[
    -- technical 0..24
    (c > ema20)::int, (c > ema50)::int, (c > sma200)::int, (ema20 > ema50 AND ema50 > ema200)::int,
    (rsi14 >= 60)::int, (rsi14 >= 70)::int, (rsi14 < 50)::int, (macd_histogram > 0)::int, (roc5 > 0)::int,
    (roc20 >= CASE WHEN market = 'EGX' THEN 12.2 ELSE 9.4 END)::int, (roc20 >= CASE WHEN market = 'EGX' THEN 23.0 ELSE 14.9 END)::int,
    (distance_52w_high >= -5)::int, (distance_52w_high <= -20)::int, (c >= high20)::int, (c >= high50)::int,
    (relative_volume20 >= 1.5)::int, (relative_volume20 >= 2.5)::int, (relative_volume20 < 1)::int, (relative_volume50 >= 2)::int,
    (volatility_annual_pct >= CASE WHEN market = 'EGX' THEN 59.6 ELSE 41.3 END)::int, (volatility_annual_pct <= CASE WHEN market = 'EGX' THEN 41.3 ELSE 25.8 END)::int,
    (medium_term_trend = 'STRONG_BULLISH')::int, (long_term_trend IN ('BULLISH','STRONG_BULLISH'))::int, (short_term_trend IS DISTINCT FROM 'STRONG_BULLISH')::int, (long_term_score >= 80)::int,
    -- ichimoku 25..33
    (ichimoku_signal = 'STRONG_BULLISH')::int, (ichimoku_signal IN ('NEUTRAL','BEARISH','STRONG_BEARISH'))::int, (c > ichimoku_tenkan)::int, (c > ichimoku_kijun)::int,
    (ichimoku_tenkan > ichimoku_kijun)::int, (ichimoku_cloud_dist_pct > 0)::int, (ichimoku_cloud_dist_pct >= 10)::int, (ichimoku_cloud_dist_pct >= 20)::int, (ichimoku_senkou_a > ichimoku_senkou_b)::int,
    -- smc 34..45
    (smc_structure = 'BULLISH')::int, (smc_last_event = 'BOS_UP')::int, (smc_last_event = 'CHOCH_UP')::int, (smc_event_bars_ago <= 3)::int,
    (smc_sweep = 'SWEEP_LOW' AND smc_sweep_bars_ago <= 5)::int, (smc_sweep = 'SWEEP_HIGH' AND smc_sweep_bars_ago <= 5)::int,
    (c BETWEEN smc_bull_ob_low * 0.98 AND smc_bull_ob_high * 1.02)::int, (smc_fvg_bull_high >= c * 0.97 AND smc_fvg_bull_low <= c)::int,
    (smc_bias LIKE '%PREMIUM')::int, (smc_bias LIKE '%DISCOUNT')::int, (smc_range_pos_pct >= 75)::int, (smc_bear_ob_low IS NOT NULL)::int,
    -- scanner 46..69
    (setup_type = 'MOMENTUM')::int, (setup_type = 'ACCUMULATION')::int, (setup_type = 'PULLBACK')::int, (setup_type NOT IN ('MOMENTUM','ACCUMULATION','PULLBACK'))::int,
    (overall_score >= 70)::int, (overall_score >= 80)::int, (overall_rank <= 3)::int, (overall_rank <= 10)::int, (momentum_score >= 70)::int,
    (accumulation_score >= 60)::int, (setup_confidence >= 60)::int, (risk_reward_t1 >= 1)::int, (target1_estimated_days <= 3)::int, (target1_estimated_days <= 5)::int,
    (g >= 5)::int, (g >= 10)::int, (relative_strength_20d > 0)::int, (relative_strength_20d >= 10)::int,
    (extension_atr >= 2)::int, (extension_atr >= 3)::int, (extension_atr < 1)::int, (close_position_pct >= 66)::int, (rsi_slope3 > 5)::int, (entry_quality_score >= 85)::int,
    -- structure 70..72
    (nearest_resistance_distance_pct < 3)::int, (resistance1 IS NULL)::int, (nearest_support_distance_pct < 3)::int,
    -- volume analysis 73..76
    (volume_change_1d_pct >= 50)::int, (volume_change_vs_20d_pct >= 100)::int, (relative_volume20_rank <= 20)::int, (traded_value_rank <= 30)::int,
    -- regime 77..81
    (market_score >= 60)::int, (market_score < 40)::int, (market_regime IN ('BULLISH','STRONG_BULLISH'))::int, (idx_ret20 > 0)::int, (idx_close > idx_sma50)::int,
    -- candles 82..93
    (c > o)::int, (abs(c - o) >= 0.6 * NULLIF(h - l, 0))::int, (o > h1)::int,
    (c > o AND c1 < o1 AND o <= c1 AND c >= o1)::int,
    (c >= o AND (LEAST(o, c) - l) >= 2 * NULLIF(abs(c - o), 0) AND (h - GREATEST(o, c)) <= abs(c - o))::int,
    (h <= h1 AND l >= l1)::int, (c > c1 AND c1 > c2 AND c2 > c3)::int, ((h - l) >= 1.5 * atr14)::int, (range10 < 0.5 * NULLIF(range30, 0))::int,
    (c > prev_week_high)::int, (c > prev_month_high)::int, (cmf20 > 0)::int,
    -- liquidity 94..95, misc 96
    (atv20 >= CASE WHEN market = 'EGX' THEN 2e7 ELSE 5e6 END)::int, (atv20 >= CASE WHEN market = 'EGX' THEN 5e7 ELSE 2e7 END)::int,
    (target1_estimated_days > 5)::int
  ], '', '0') AS bits
FROM f;

CREATE INDEX ON lab_features (market, slice);
CREATE INDEX ON lab_features (stock_id, d);

SELECT market, slice, count(*) AS rows, count(outcome) AS evaluated, length(min(bits)) AS bit_len,
  count(*) FILTER (WHERE length(bits) <> 97) AS bad_len
FROM lab_features GROUP BY 1, 2 ORDER BY 1, 2;
