# Observability & Telemetry

**MarketSage** sends traces, metrics, and structured logs to the **Aspire** dashboard
bundled in the Docker stack. Every `/analyze` call produces a full trace tree — one
root span per request with named child spans for each pipeline step.

Open Aspire at **http://localhost:18889** (Traces tab).

---

## OTEL span hierarchy

Each `/analyze` or `/analyze/stream` HTTP request creates a **root trace** via the
FastAPI OTEL middleware. The **TickerAgent** wraps the entire pipeline in an
`agent.run` span; each skill gets its own `skill.<name>` child span:

```
POST /analyze  (root — FastAPI middleware)
│
└── agent.run                         ← TickerAgent.run()
    │   ticker, skills.count, agent.success, agent.elapsed_ms
    │
    ├── skill.fetch_data              ← FetchDataSkill.run()
    │   │   skill.name, skill.critical, skill.attempt, skill.elapsed_ms
    │   │
    │   ├── data.fetch_price_fundamentals   ← fetch_yfinance()
    │   │   └── GET https://query2.finance.yahoo.com/...  (auto)
    │   │
    │   ├── data.compute_indicators         ← compute_indicators()
    │   │   ├── event: timeframe_done {timeframe:"1H", rsi:"54.2", rec:"BUY"}
    │   │   ├── event: timeframe_done {timeframe:"4H", ...}
    │   │   └── event: timeframe_done {timeframe:"1D", ...}
    │   │
    │   ├── data.fetch_balance_sheet        ← fetch_balance_sheet()
    │   │
    │   ├── data.fetch_macro                ← fetch_fred_macro()
    │   │   ├── GET https://fred.stlouisfed.org/...FEDFUNDS  (auto)
    │   │   └── GET https://www.multpl.com/shiller-pe/...    (auto)
    │   │
    │   └── data.fetch_news                 ← fetch_finnhub_news()
    │
    ├── skill.ai_analysis             ← AIAnalysisSkill.run()   (may retry)
    │   │   skill.retries, skill.attempt
    │   │
    │   └── llm.chat                        ← call_ollama()
    │       └── POST http://ollama:11434/api/chat  (auto)
    │
    ├── skill.opportunity_detect      ← OpportunityDetectSkill.run()
    │
    ├── skill.persist                 ← PersistSkill.run()
    │
    └── skill.alert                   ← AlertSkill.run()
```

---

## Span attributes

### `data.fetch_price_fundamentals`

| Attribute | Type | Example |
|---|---|---|
| `ticker` | string | `"AAPL"` |
| `data_source` | string | `"yfinance"` |
| `market_cap` | string | `"3200000000000"` |
| `pe_trailing` | string | `"32.4"` |
| `pe_forward` | string | `"28.1"` |

### `data.compute_indicators`

| Attribute | Type | Example |
|---|---|---|
| `ticker` | string | `"AAPL"` |
| `error_count` | int | `0` |

Events (one per timeframe computed):

| Attribute | Example |
|---|---|
| `timeframe` | `"1H"` |
| `rsi` | `"54.2"` |
| `rec` | `"BUY"` |

### `data.fetch_balance_sheet`

| Attribute | Type | Example |
|---|---|---|
| `ticker` | string | `"AAPL"` |
| `cache_hit` | bool | `false` |
| `period` | string | `"2026-03-31"` |

### `data.fetch_macro`

| Attribute | Type | Example |
|---|---|---|
| `data_source` | string | `"fred+multpl"` |
| `cache_hit` | bool | `false` |
| `series_fetched` | int | `5` |

### `data.fetch_news`

| Attribute | Type | Example |
|---|---|---|
| `ticker` | string | `"AAPL"` |
| `data_source` | string | `"finnhub"` |
| `api_key_set` | bool | `true` |
| `article_count` | int | `5` |

### `llm.chat`

| Attribute | Type | Example |
|---|---|---|
| `gen_ai.system` | string | `"ollama"` |
| `gen_ai.request.model` | string | `"qwen2.5:7b"` |
| `llm.ticker` | string | `"AAPL"` |
| `llm.prompt_chars` | int | `2148` |
| `llm.input_tokens` | int | `512` |
| `llm.output_tokens` | int | `198` |
| `llm.ttft_s` | float | `0.843` |
| `llm.total_latency_s` | float | `9.12` |
| `llm.response_chars` | int | `410` |

**TTFT** (time to first token) is derived from Ollama's response body fields:
`(load_duration + prompt_eval_duration) / 1e9` — it measures how long the model
took to load + prefill before generating the first output token.

---

## Sensitive-data toggle

By default, the full prompt text and LLM response text are **not** included in spans.
Prompts contain ticker context (balance sheet figures, news headlines) that should not
be stored in trace backends without access controls.

To enable full text in Aspire span events, set in `.env`:

```env
OTEL_INCLUDE_LLM_CONTENT=true
```

Then `docker compose up -d backend` to apply. When enabled, the `llm.chat` span gains
two events:

| Event | Content |
|---|---|
| `llm.prompt` | Full prompt text sent to Ollama |
| `llm.response` | Raw JSON response from Ollama |

> ⚠️ **Privacy:** This setting should only be enabled in development environments.
> Prompts may contain financial context, balance sheet data, and news that could be
> sensitive. Aspire data is stored locally, but consider the implications before enabling
> in shared environments.

---

---

## OTEL metrics

The `marketsage.agent` meter emits five instruments, visible in Aspire's **Metrics** tab:

| Instrument | Type | Dimensions | What it measures |
|---|---|---|---|
| `marketsage.agent.runs` | Counter | `ticker`, `success` | Completed pipeline runs — track total volume and failure rate per ticker |
| `marketsage.agent.duration` | Histogram | `ticker`, `success` | Total pipeline wall-clock time in ms — p50/p95/p99 latency |
| `marketsage.skill.calls` | Counter | `skill`, `success`, `attempt` | Individual skill executions; each retry attempt is counted separately |
| `marketsage.skill.duration` | Histogram | `skill`, `success` | Per-skill latency — `ai_analysis` will dominate; useful for spotting Ollama degradation |
| `marketsage.skill.retries` | Counter | `skill`, `ticker` | Retry events — spikes here indicate Ollama instability |

All instruments are no-ops when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set (no metric data outside Docker).

---

## Reading Aspire

### Traces

1. Open **http://localhost:18889** → **Traces** tab
2. Filter by service: `offgrid-trader`
3. Click any `/analyze` trace to expand the waterfall — the root span is `agent.run`
4. Click `skill.ai_analysis` to see attempt count, elapsed time, and retry count
5. Click `llm.chat` to see token counts, TTFT, and latency

### Metrics

1. Open **http://localhost:18889** → **Metrics** tab
2. Select `marketsage.agent.duration` for a latency histogram per ticker
3. Select `marketsage.skill.calls` to see the per-skill call volume breakdown
4. Watch `marketsage.skill.retries` to catch Ollama instability early

### Diagnosing slow analysis

| Symptom | What to look at |
|---|---|
| Long `skill.ai_analysis` span | `llm.ttft_s` on `llm.chat` high → model loading from disk; `llm.total_latency_s` high → model too large for VRAM |
| `marketsage.skill.retries` spiking | Ollama is timing out; check `OLLAMA_TIMEOUT` or model size vs. VRAM |
| Long `data.fetch_balance_sheet` | `cache_hit: false` → yfinance balance sheet fetch; check network |
| Long `data.fetch_macro` | `cache_hit: false` → first fetch of the day; FRED or multpl.com may be slow |
| Missing `data.fetch_news` span | No `FINNHUB_API_KEY` set (span still appears but `article_count: 0`) |

---

## Log lines in Aspire

In addition to traces, all Python `logging.INFO` lines are forwarded to Aspire as
structured log records (visible under **Logs** → filter by `marketsage.analysis` or
`marketsage.data`):

```
ollama ▶ ticker=AAPL model=qwen2.5:7b prompt_chars=2148
ollama ◀ ticker=AAPL model=qwen2.5:7b latency=9.1s in_tok=512 out_tok=198 ttft=0.84s chars=410
balance_sheet ◀ AAPL period=2026-03-31 assets=364980000000.0
macro ◀ fetched=5/5 series
```

These log lines exist alongside the OTEL spans and provide a flat, scrollable view
of the pipeline for quick debugging.
