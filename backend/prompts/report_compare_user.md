Compare these two {{REPORT_TYPE}} reports.

The payload has four parts:
- `comparability` — the backend's strictness grade and reasons. Obey it (rule 2).
- `diff` — the deterministic metric and configuration deltas the trader is looking at. Deltas
  are B − A. `higher_is_better` tells you which direction is an improvement; `null` means the
  metric has no good/bad direction. Reason over these exact numbers.
- `report_a` — the complete snapshot of the earlier period.
- `report_b` — the complete snapshot of the later period.

Each snapshot contains `window` (dates and length), `window_economics` (performance inside the
window), all-time economics, `signals`, top movers, `blocked_events` (trades the system wanted
but could not place), any bucketed breakdowns, and the `tuning` configuration in force.

{{COMPARISON_JSON}}
