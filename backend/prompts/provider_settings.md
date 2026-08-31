# Provider Settings and Adapters

## Exact model IDs

- Gemini Flash: `gemini-3.5-flash`
- Gemini Flash-Lite: `gemini-3.5-flash-lite`
- Groq Qwen: `qwen/qwen3.6-27b`
- Mistral rolling alias: `mistral-small-latest`
- Current pinned Mistral Small version: `mistral-small-2603`

## Reproducibility

For every request, store:

- provider
- requested model ID
- resolved model/version when available
- prompt name and prompt version
- JSON Schema version
- reasoning/thinking setting
- sampling settings
- max output tokens
- request data hash
- raw response
- parsed response
- syntax validation result
- schema validation result
- semantic validation result
- retry count and fallback model
- latency and token usage

Never compare historical backtests across silently changing `latest` aliases without storing the resolved version.

## Gemini adapter

Recommended:

- Native JSON Schema structured output
- Signal triage on Flash-Lite: `thinking_level="minimal"`
- Signal synthesis on Flash: `thinking_level="minimal"` or `"low"`
- Backtest comparison/advice: `thinking_level="low"`; test `"medium"` only where it improves held-out results
- Keep Gemini 3.x sampling defaults unless your own evaluation proves an improvement
- Put stable behavioral rules in the system instruction
- Put the complete data payload first in the user message and the final task sentence after it

## Groq Qwen adapter

Recommended:

```json
{
  "model": "qwen/qwen3.6-27b",
  "response_format": {"type": "json_object"},
  "reasoning_effort": "default",
  "reasoning_format": "hidden"
}
```

Use `reasoning_effort="none"` for simple classification and `"default"` for comparison or experiment selection. Because Groq currently offers JSON Object Mode rather than schema enforcement for this model, include the full schema contract in the prompt, validate locally, and allow one targeted repair retry. A second failure should trigger a fallback model or a typed `model_error`; do not accept partially valid JSON.

For reasoning-mode calls, test a provider-specific single user message with the critical rules first, followed by the data block and task. Do not use `reasoning_format="raw"` with JSON mode.

## Mistral adapter

Recommended:

- Use custom structured output with the included JSON Schema rather than plain JSON mode
- Use `reasoning_effort="none"` for classification and routine reviews
- Use `reasoning_effort="high"` only after validating that your SDK and structured-output path return a clean final object
- Use a concise system prompt and one or two semantic edge-case examples
- Use worded/ordinal scales in the prompt; map them to numeric UI values in code

## Validation pipeline

1. Parse JSON.
2. Validate JSON Schema.
3. Validate semantic invariants.
4. On failure, make one repair call containing only:
   - the invalid response;
   - exact validator errors; and
   - "Return the corrected JSON object only. Do not change supported facts."
5. If repair fails, switch to the fallback model or return `model_error`.

## Semantic invariants

Signal scan:

- `decision="none"` implies `selected_plan_id=null`.
- A non-null plan ID must exist in the input candidate list and match the decision side.
- Every evidence/risk `source_path` must exist in the input payload.
- Confidence value must match its band and be a multiple of 5.
- Invalid or insufficient input cannot produce a long/short decision.

Backtest tasks:

- A run cannot be a deployment candidate when `is_out_of_sample=false`.
- A comparison with partial/no comparability cannot produce a winner unless an explicit normalized comparison is supplied.
- LLM value add cannot be assessed without a matched mode pair.
- An experiment selector cannot output a candidate ID absent from the candidate list.
