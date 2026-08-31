<DATA>
{experiment_selection_json}
</DATA>

Using only DATA, return one object conforming to ExperimentSelectionV2.

Recommended input shape:
{
  "current_run": {
    "run_id": "string",
    "is_out_of_sample": true,
    "metrics": {},
    "diagnostics": {
      "mae_distribution_r": {},
      "mfe_distribution_r": {},
      "holding_time_winners": {},
      "holding_time_losers": {},
      "exit_reason_counts": {},
      "confidence_calibration": {},
      "performance_by_floor_train": [],
      "performance_by_floor_validation": [],
      "performance_by_regime": [],
      "performance_by_ticker": []
    }
  },
  "research_constraints": {
    "locked_test_window": "string",
    "minimum_effective_trades": 0,
    "unchanged_fields": [],
    "objective": "string"
  },
  "candidate_experiments": [
    {
      "candidate_id": "string",
      "hypothesis": "string",
      "changes": {},
      "kept_constant": [],
      "diagnostic_support": [],
      "expected_effect": "string",
      "success_criteria": [],
      "failure_criteria": [],
      "overfitting_risk": "low|medium|high"
    }
  ]
}
