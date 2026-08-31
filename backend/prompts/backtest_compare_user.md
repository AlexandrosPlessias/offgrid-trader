<DATA>
{backtest_comparison_json}
</DATA>

Using only DATA, return one object conforming to BacktestComparisonV2.

Recommended input shape:
{
  "comparison_id": "string",
  "comparability": {
    "backend_grade": "full|partial|none",
    "matched_fields": [],
    "different_fields": [],
    "normalization_notes": []
  },
  "runs": [
    {
      "run_id": "string",
      "mode": "rules|llm|hybrid",
      "model_id": "string|null",
      "prompt_version": "string|null",
      "is_out_of_sample": true,
      "total_trades": 0,
      "effective_trades": 0.0,
      "expectancy_r_after_costs": 0.0,
      "expectancy_ci95": [0.0, 0.0],
      "sharpe": 0.0,
      "deflated_sharpe": null,
      "max_drawdown_r": 0.0,
      "profit_factor": 0.0,
      "coverage": 0.0,
      "turnover": 0.0,
      "robustness_flags": []
    }
  ],
  "matched_mode_pairs": [
    {
      "rules_run_id": "string",
      "llm_or_hybrid_run_id": "string",
      "paired_delta_expectancy_r": 0.0,
      "paired_delta_ci95": [0.0, 0.0],
      "delta_coverage": 0.0,
      "delta_max_drawdown_r": 0.0,
      "delta_turnover": 0.0
    }
  ]
}
