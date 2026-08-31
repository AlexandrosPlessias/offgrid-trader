<DATA>
{backtest_run_json}
</DATA>

Using only DATA, return one object conforming to BacktestReviewV2.

Recommended input shape:
{
  "run": {
    "run_id": "string",
    "strategy_id": "string",
    "prompt_version": "string",
    "model_id": "string",
    "mode": "rules|llm|hybrid",
    "universe": ["string"],
    "start": "YYYY-MM-DD",
    "end": "YYYY-MM-DD",
    "is_out_of_sample": true,
    "execution_rules_hash": "string",
    "cost_model_hash": "string"
  },
  "metric_definitions": {
    "return_frequency": "per_trade|daily",
    "sharpe_method": "string",
    "max_drawdown_unit": "R|percent",
    "false_positive_definition": "string|null"
  },
  "metrics": {
    "total_trades": 0,
    "effective_trades": 0.0,
    "win_rate": 0.0,
    "avg_win_r": 0.0,
    "avg_loss_r": 0.0,
    "expectancy_r_after_costs": 0.0,
    "expectancy_ci95": [0.0, 0.0],
    "profit_factor": 0.0,
    "sharpe": 0.0,
    "probabilistic_sharpe": null,
    "deflated_sharpe": null,
    "max_drawdown_r": null,
    "max_drawdown_percent": null,
    "drawdown_duration": null,
    "exposure": null,
    "turnover": null
  },
  "robustness": {
    "number_of_trials": 1,
    "untouched_holdout": true,
    "walk_forward_or_purged_cv": true,
    "fee_stress_pass": true,
    "slippage_stress_pass": true,
    "delay_stress_pass": true,
    "regime_stability": "weak|mixed|strong",
    "ticker_concentration": 0.0
  },
  "per_ticker": [],
  "per_regime": [],
  "backend_flags": []
}
