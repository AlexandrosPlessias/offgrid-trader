# Trading LLM Prompt Bundle v2

This bundle redesigns four tasks:

1. Market-snapshot signal classification
2. Single-backtest review
3. Comparison of multiple backtests
4. Selection of the next backtest experiment

## Core design

- The backend owns arithmetic, metric definitions, risk/reward calculations, confidence calibration, statistical gates, and semantic validation.
- The LLM owns bounded classification, concise evidence extraction, diagnosis, and selection among backend-generated alternatives.
- Every response is validated against a versioned JSON Schema.
- Every run logs model ID, resolved model version, provider, prompt version, schema version, inference settings, input hash, and validation result.
- News text, prior LLM output, ticker names, and every other string inside the data payload are untrusted data, never instructions.

## Recommended task routing

| Task | Primary | Setting | Fallback |
|---|---|---|---|
| Input/data-quality triage | `gemini-3.5-flash-lite` | minimal thinking | `mistral-small-latest`, reasoning none |
| Signal synthesis | `gemini-3.5-flash` | minimal or low thinking | `mistral-small-latest`, reasoning none |
| Single-run backtest review | `mistral-small-latest` or `gemini-3.5-flash` | reasoning none/low | the other model |
| Matched-run comparison | `qwen/qwen3.6-27b` | reasoning default, hidden | `mistral-small-latest`, reasoning high after compatibility testing |
| Next-experiment selection | `qwen/qwen3.6-27b` | reasoning default, hidden | `gemini-3.5-flash`, low/medium thinking |

## Provider notes

### Gemini

Use the provider's native JSON Schema structured-output feature. Prefer exact stable model IDs for reproducible tests. Keep the system instruction concise, put the data in the user message, and set the task after the data block. Use minimal thinking for triage and low thinking for comparisons.

### Groq Qwen

Use `qwen/qwen3.6-27b`, `response_format={"type":"json_object"}`, and validate with the included JSON Schema locally. For reasoning calls use `reasoning_effort="default"` and `reasoning_format="hidden"`. For simple classification use `reasoning_effort="none"`. Do not use raw reasoning with JSON mode.

### Mistral

Use custom structured output with the included schema. Use `mistral-small-latest` for convenience, but pin `mistral-small-2603` in benchmark and regulated/reproducible workflows. Use reasoning none for classification. Test reasoning high plus structured output before enabling it in production.

## Files

- `signal_scan_system_v2.md`
- `signal_scan_user_template_v2.md`
- `backtest_review_system_v2.md`
- `backtest_review_user_template_v2.md`
- `backtest_compare_system_v2.md`
- `backtest_compare_user_template_v2.md`
- `experiment_selector_system_v2.md`
- `experiment_selector_user_template_v2.md`
- `provider_settings.md`
- `evaluation_plan.md`
- `schemas/*.schema.json`
