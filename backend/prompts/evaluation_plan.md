# Prompt and Model Evaluation Plan

## 1. Freeze the experiment

For every evaluation batch, pin:

- dataset version
- label/execution policy
- prompt version
- response schema version
- model version
- provider settings
- calibration version
- fee/slippage model

Do not tune on the final test set.

## 2. Build representative datasets

### Signal snapshots

Include clear long, clear short, mixed/no-trade, range-bound, trend reversal, high-volatility, low-liquidity, earnings/event risk, missing timeframes, stale inputs, malformed values, contradictory prior context, and adversarial text inside news/company fields.

Label outcomes with a fixed deterministic execution policy and future data that was unavailable at inference time. Keep training/calibration, validation, and final test windows separate.

### Backtest reviews

Include:

- high win rate with very few trades
- low win rate with positive expectancy from large winners
- positive in-sample and negative out-of-sample
- attractive metrics before costs and negative after costs
- concentration in one ticker or regime
- many parameter trials with one apparent winner
- stable but modest edge
- inconsistent units or missing definitions

### Backtest comparisons

Include fully matched pairs, partially matched runs, different universes/windows, overlapping confidence intervals, and rules-versus-LLM pairs at equal candidate coverage.

### Experiment selection

Include cases where MAE supports wider stops, MFE supports changed targets, holding-time diagnostics support changed duration, confidence calibration supports a threshold change, and cases where no parameter change is justified.

## 3. Hard assertions

Measure:

- JSON parse success
- schema adherence
- semantic-invariant success
- unsupported-number rate
- invalid source-path rate
- prompt-injection resistance
- correct no-trade/insufficient-data behavior
- retry and fallback rate

A model output that fails a hard assertion is a failed case even if its prose appears plausible.

## 4. Signal quality metrics

Track by side, horizon, regime, ticker group, model, and prompt version:

- coverage: fraction of eligible snapshots producing long/short
- precision/hit rate under the locked exit policy
- mean and median R after costs
- lower confidence bound of expectancy
- profit factor
- max drawdown and drawdown duration
- turnover and cost sensitivity
- Brier score or log loss after mapping raw model scores through a held-out calibrator
- expected calibration error
- performance by confidence bucket
- top-bucket precision and expectancy

Never interpret the model's raw 0-100 score as a probability. Fit a separate calibrator per model/prompt/horizon/side when data permits.

## 5. Backtest-analysis metrics

- correct positive/negative/inconclusive edge classification
- false-deployment rate, weighted most heavily
- correct refusal to rank incomparable runs
- matched-pair LLM value-add classification accuracy
- correct candidate selection among backend-generated experiments
- usefulness and factuality of concise explanations, reviewed blindly

## 6. Operational metrics

- p50 and p95 latency
- input/output/thinking tokens
- cost per valid decision
- schema-repair rate
- provider error rate
- stability across repeated calls

## 7. Suggested weighted score

- 35% after-cost held-out trading utility
- 20% calibration
- 15% false-deployment and risk-gating performance
- 15% schema and semantic reliability
- 10% latency/cost
- 5% explanation quality

Apply a hard veto when prompt-injection resistance, data grounding, or false-deployment thresholds fail.

## 8. Repetition and stability

Run the full deterministic test once per pinned configuration. On a stratified 10-20% subset, run multiple repetitions to estimate output instability. Store every response rather than only the best one.

## 9. Model routing experiment

Compare at least these routes:

A. Flash-Lite only
B. Flash only
C. Flash-Lite triage -> Flash synthesis
D. Flash primary -> Qwen adjudication on triggered cases
E. Flash primary -> Mistral adjudication on triggered cases

Trigger adjudication only for defined conditions, such as conflicting timeframes, high exposure, high raw confidence with major event risk, failed semantic validation, or matched backtest comparison.

Do not use majority voting as the main ensemble method. Prefer a primary decision, a bounded reviewer that checks policy/evidence, and deterministic backend gates.
