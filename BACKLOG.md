# Backlog — offgrid-trader

Future ideas and planned improvements. No priority order within each item.

---

## ✅ Completed

### ✅ 0. Data visualizer + beginner documentation
*Shipped on branch `feature/backlog-item-0-explorer`*

- **SSE live stepper** — `POST /analyze/stream` streams fetch → AI → detect steps with per-step timing; dashboard panel shows real-time progress
- **RSI / MACD / EMA charts** — Recharts bar charts across 1H / 4H / 1D; RSI reference lines at 30/70; MACD histogram color-coded; EMA shows % deviation from price
- **Price history chart** — 3-month OHLCV area chart + volume bars; gated behind a toggle switch; only in Analysis Explorer
- **Educational InfoTip tooltips** — ℹ hover tooltips on every chart title with plain-English explanations
- **Raw indicator table** — collapsible per-timeframe table (RSI, MACD, EMA, BB, Stoch, recommendation)
- **Analysis Explorer page** — dedicated UI tab with 6 numbered sections: pipeline walkthrough, price snapshot, historical chart, technical indicators, AI reasoning, signals detected
- **Learn / Education page** — in-app wiki tab: how the pipeline works, indicator reference, opportunity-detection rules, full trading glossary, disclaimer + external links
- **DB persistence for SSE** — `save_analysis` + `save_signal` called at end of SSE stream so ad-hoc runs are visible in the signals table
- **Richer telemetry** — structured `INFO` log lines for every yfinance fetch, every TradingView timeframe call, and every Ollama I/O call; visible in Aspire

---

## ✅ 1. Replace tradingview-ta with a free, open-source indicator stack
*Shipped on branch `feature/backlog-item-1-indicators`*

`tradingview-ta` works by scraping TradingView's internal API, which is not an officially supported integration and requires users to accept TradingView's ToS. Replace it with a combination of free, properly licensed alternatives:

### Proposed stack

| Source | Role | Free tier | Key notes |
|---|---|---|---|
| **yfinance** *(keep)* | OHLCV data for all timeframes | Unlimited (Yahoo Finance) | Already used for price/fundamentals; download `1h`/`4h`/`1d` history here too |
| **pandas-ta** | Compute RSI, MACD, EMA, BB, Stoch from OHLCV | MIT library, no API key | Runs locally from OHLCV — no network call after yfinance download |
| **Finnhub.io** *(optional)* | Real-time quotes + news headlines | 60 req/min (free API key) | News headlines feed into the AI prompt as a sentiment signal — bonus feature |
| **Polygon.io** *(optional / future)* | Higher-res tick/agg data | 5 calls/min delayed (free) | Useful if yfinance data quality is insufficient; upgrade path to real-time |

### Why this combination is feasible

- **pandas-ta** is a pure-Python library that computes every indicator `tradingview-ta` currently provides (RSI, MACD, EMA20/50/200, Bollinger Bands, Stochastic) from an OHLCV DataFrame. No API key, no ToS risk, no rate limits.
- **Multi-timeframe** data comes from calling `yfinance.download(ticker, period="5d", interval="1h")` / `"4h"` / `"1d"` — the same source already used for price data.
- The "recommendation" string (BUY/SELL/NEUTRAL) that `tradingview-ta` synthesises can be replicated: count bullish vs bearish indicator readings and threshold into three labels.
- **Finnhub** free tier (no card required at signup) provides recent news headlines and analyst recommendations per ticker — feeding these into the Ollama prompt is a meaningful accuracy improvement at zero cost.

### Why not Alpha Vantage for indicators?

Alpha Vantage is an *external API service* with a **25 requests/day** free limit. A single scan of 3 tickers × 3 timeframes × 5 indicators = 45 API calls per cycle — the limit is gone before the first scan finishes. pandas-ta runs the same computations locally with no limits whatsoever.

### Implementation plan

1. **`backend/data.py`** — replace `fetch_tradingview()` with `compute_indicators(ticker, timeframe)` that:
   - Calls `yfinance.download(ticker, period=…, interval=…)` for 1H/4H/1D
   - Runs `pandas_ta` on the DataFrame to produce RSI, MACD, EMA, BB, Stoch values
   - Derives a recommendation label from the combined readings
   - Returns the same dict shape as `fetch_tradingview()` so downstream code is unchanged
2. **`backend/data.py`** — add optional `fetch_finnhub_news(ticker)` wrapper; gated by `FINNHUB_API_KEY` in `.env`
3. **`requirements.txt`** — add `pandas-ta`; remove `tradingview-ta`; add `finnhub-python` (optional)
4. **`.env.example`** — add `FINNHUB_API_KEY=` (empty = disabled)
5. **`backend/analysis.py`** — if Finnhub key present, append recent headlines to the prompt context
6. **Smoke test** — mock `yfinance.download` + `pandas_ta` in `tests/smoke_test.py`

### Notes / risks

- `pandas-ta` indicator values may differ slightly from TradingView's (different lookback defaults). Thresholds in `opportunities.py` may need minor tuning after the switch — run the backtest item (#4) to validate.
- `yfinance` does not officially support a `4h` interval on all tickers; use `2h` as a fallback or derive from `1h` bars.
- Polygon.io free tier data is delayed (~15 min) and rate-limited — suitable only as a fallback or for end-of-day backtesting, not real-time scanning.
- If Finnhub API key is absent, the system falls back to the current behaviour (no news); this is a zero-config backward-compatible change.

### Architecture documentation (bundle with this item)

While reworking the data layer, also add Mermaid diagrams to `docs/wiki/architecture.md`:

- **Pipeline diagram** — ticker → yfinance → pandas-ta → Ollama → detect → DB → alert
- **Infrastructure diagram** — Docker Compose services, ports, `ai-shared` network, volumes
- **Data-flow diagram** — how OHLCV maps to indicators, how AI JSON maps to opportunities

Mermaid renders natively in GitHub — no extra tooling needed.

---

## ✅ 2. Richer data layer — news display, fundamentals, balance sheet, macro, LLM telemetry
*Shipped on branch `feature/market-data-enrichment`*

Five additions to the data pipeline and UI — all shipped:

| # | Feature | Notes |
|---|---|---|
| **2a** | **News card in Explorer** | `fetch_finnhub_news` returns `List[Dict]` with headline/source/url/datetime; rendered as clickable links |
| **2b** | **Fundamentals card** | Sector, industry, market cap (`fmtMarketCap`), P/E TTM + Forward P/E from yfinance `.info` |
| **2c** | **Balance sheet** | `fetch_balance_sheet` via yfinance; assets/liabilities/equity/debt/cash/D:E; daily DB cache per ticker |
| **2d** | **US macro + Shiller CAPE** | `fetch_fred_macro`: FEDFUNDS, CPI YoY, UNRATE, T10Y2Y from key-free FRED CSV; Shiller CAPE from multpl.com (no key); global 6h DB cache |
| **2e** | **Rich OTEL span hierarchy** | Per-step spans (`data.fetch_price_fundamentals`, `data.compute_indicators`, `data.fetch_news`, `data.fetch_balance_sheet`, `data.fetch_macro`, `llm.chat`); token counts + TTFT from Ollama response body; `OTEL_INCLUDE_LLM_CONTENT` toggle for full prompt/response events |

**Decisions recorded:**
- P/E (trailing + forward) and Shiller CAPE are **in scope** (initially excluded, then added back).
- CAPE source: **multpl.com** (no API key; HTML scrape; 24h DB cache). FRED does not have an official Shiller CAPE series.
- FRED access: **key-free CSV** (`fredgraph.csv` endpoint) — no `FRED_API_KEY` added to config.
- Zero new Python dependencies — all required packages already in `requirements/backend.txt`.

---

## ✅ 3a. Low-cost / zero-cost cloud LLM hosting
*Shipped on branch `feat/backlog-3b-agentic-arch`*

Added full support for free cloud inference alongside (or instead of) local Ollama.

| Provider | Sign-up | Free tier | Default model |
|---|---|---|---|
| **Groq Cloud** | https://console.groq.com | ~30 req/min, 6 000 req/day | `llama-3.3-70b-versatile` |
| **Google Gemini** | https://aistudio.google.com | Flash-Lite 1 000 req/day · Flash 250 req/day | `gemini-3.5-flash-lite` |
| **Mistral AI** | https://console.mistral.ai | ~1B tokens/month free | `mistral-small-latest` |

### What shipped

- **`LLM_PROVIDER` env var** — `ollama` (default) / `groq` / `gemini` / `mistral` / `custom`; local Ollama path unchanged
- **Settings page → AI Provider section** — provider dropdown, API key field, per-provider model dropdown + free text, base URL (custom), reasoning-effort dropdown, and a 'Use .env defaults' toggle; changes take effect instantly (DB-backed, no restart)
- **Model tags** — every analysis result shows which provider and model produced it (stored in `analysis_log` and `signals`); shown as a chip in the Explorer and a bubble on dashboard signal cards
- **`make infra` auto-skip** — when `LLM_PROVIDER ≠ ollama`, Ollama containers are skipped automatically (saves RAM/VRAM); override with `--with-ollama`
- **`call_cloud_llm()`** in `analysis.py` — uses the `openai` SDK with per-provider `base_url`/`api_key`/`reasoning_effort` handling; `LLMError` base class for backward-compatible error handling

### Privacy note

When using a cloud provider, ticker data and market snapshots leave your machine and are processed by the chosen provider's API. See their privacy policies at the sign-up URLs above.

### Remaining / known gaps

- ✅ **Prompt revision** — `backend/prompts/system_prompt.md` rewritten with confidence calibration scale, show-your-work signals guidance, and structural-level entry/stop/target rules; ships with score_breakdown on branch `feat/backlog-3a-cloud-llm`
- **Multi-model fallback** — moved to backlog item 3c below

---

## ✅ 3b. Agentic architecture — workers, skills, orchestrator, memory
*Shipped on branch `feat/backlog-3b-agentic-arch`*

Replaced the monolithic scan loop with a lightweight agent framework — no new dependencies, no new external services.

| Component | File | What |
|---|---|---|
| **Skills** | `backend/skills/` | Five independently testable pipeline steps: `FetchDataSkill`, `AIAnalysisSkill` (retries on OllamaError), `OpportunityDetectSkill`, `PersistSkill`, `AlertSkill` |
| **TickerAgent** | `backend/agent.py` | Runs skills in sequence; retries `can_retry` skills with exponential back-off; loads/saves memory; emits structured SSE events |
| **MemoryLayer** | `backend/memory.py` | Per-ticker context in `ticker_memory` DB table (UPSERT); injected into AI prompt as `PRIOR CONTEXT` section; 48h TTL |
| **Orchestrator** | `backend/orchestrator.py` | Sorts watchlist by scan staleness; caps concurrency at 3 via `asyncio.Semaphore` |
| **Infra cleanup** | `infra/` | Moved all Docker files from root into `infra/`; added `Makefile` (`make up/build/down/infra`) |

New SSE event types: `type:"retry"` (skill retried with back-off), `type:"memory"` (prior context loaded).

**Remaining / future:**
- Tool-use loop — give the LLM function-calling tools (fetch price, query DB, search news) for multi-step reasoning (ReAct style)

---

## 3c. Multi-model fallback + cloud hosting (Vercel / Fly.io)

*Branch: `feat/backlog-3c-fallback-hosting`*

Two closely related capabilities that build on item 3a and are best shipped together: automatic provider fallback when a quota is hit, and deploying the full stack publicly so it runs without a local machine.

---

### Part 1 — Multi-model fallback

When the active LLM provider fails (network error, rate limit, quota exhaustion) automatically retry the same request with a second configured provider/model, instead of surfacing the error to the user.

#### Why this matters

Cloud free tiers are generous but not unlimited — Groq has a 6 000 req/day cap, Gemini Flash 250 req/day, Mistral varies by model. A sequential watchlist scan across multiple tickers can exhaust one provider's quota within a session. Without fallback, the user sees an error and must manually switch providers in Settings.

#### Design

| Priority | Provider / Model | Configured via |
|---|---|---|
| 1st | Primary (from Settings page) | existing `llm_provider` / `llm_model` DB keys |
| 2nd | Fallback provider | new `llm_fallback_provider` / `llm_fallback_model` DB keys |
| 3rd | (optional) Second fallback | new `llm_fallback2_*` DB keys |

Fallback fires on any `LLMError` (connection refused, HTTP 429, HTTP 5xx, timeout). If all configured providers fail, the original error is re-raised to the user as today.

#### Implementation scope

1. **`backend/analysis.py`** — wrap `call_llm()` in a retry loop that iterates through the fallback chain; log each attempt with provider name and error reason
2. **`backend/config.py`** / **`backend/main.py`** — new `llm_fallback_provider` / `llm_fallback_model` setting keys; expose in `GET /settings` and `POST /settings/llm`
3. **Settings page** — add a second "Fallback provider" row beneath the primary; same fields (provider dropdown, API key, model); shown only when primary is a cloud provider
4. **SSE stream** — emit a `type:"fallback"` event when a retry fires so the Explorer pipeline shows which provider actually ran

---

### Part 2 — App hosting (Vercel + Fly.io)

Host the full stack publicly for free — no local machine needed once a cloud LLM is configured (item 3a above).

| Layer | Platform | Free tier | Notes |
|---|---|---|---|
| **Frontend** | [Vercel](https://vercel.com) | Unlimited hobby projects | Vite SPA — `vite build` + `vercel --prod`, zero config |
| **Backend + DB** | [Fly.io](https://fly.io) | 3 shared-CPU VMs, 3 GB storage | FastAPI + SQLite + scheduler; persistent volume at `/app/data` |

#### What this covers

1. **Production `Dockerfile`** for the backend — strip Aspire/OTEL overhead for the free tier, keep health endpoint
2. **`fly.toml`** — `internal_port=8000`, volume mount at `/app/data`, process group for the scheduler
3. **Deploy script** — `fly secrets set` for `LLM_PROVIDER`, `GROQ_API_KEY`, `WATCHLIST`, alert credentials
4. **Vercel project** for the Vite frontend — `VITE_API_URL` points at the Fly.io backend URL; no separate API gateway needed
5. **`SETUP.md` cloud-deploy section** — step-by-step from zero to public URL

#### Constraints and notes

- SQLite on Fly.io persistent volume survives redeploys and restarts but is not replicated. Sufficient for single-user / personal use.
- Fly.io free tier machines share CPU — Ollama cannot run here; must use Groq or a custom cloud endpoint.
- Vercel free tier has 100 GB bandwidth/month and zero cold-start latency for a static build.
- CORS: backend `CORS_ORIGINS` must include the Vercel preview URL pattern (`*.vercel.app`) plus the custom domain if set.

### Dependencies

- Item 3a must be complete (cloud LLM configured) — ✅ done.

---

## ✅ 4. Backtesting + virtual wallet simulation

Evaluate how good the system's signals actually are by replaying them against historical data and tracking a simulated portfolio.

**Delivered in two phases — split from the original spec for scope management:**

### ✅ Phase 1 — Backtesting engine *(shipped on branch `feat/backlog-4-backtesting-engine`)*

Day-by-day signal replay, forward outcome evaluation, and risk-normalized performance metrics.

- **Signal replay**: walk trading days in the window; at each day build an as-of `market_data` dict (historical OHLCV sliced to that day, empty macro/fundamentals/news to avoid look-ahead) and run it through the live `detect_opportunities` pipeline.
- **ATR volatility bracket**: rule signals carry an `entry` price but no stop/target — synthesize a bracket scaled to recent Average True Range (configurable ATR multiple + reward:risk ratio). AI-mode signals keep their own bracket.
- **Outcome evaluation**: walk forward daily bars; long wins if `high ≥ target` before `low ≤ stop` (conservative tie-break: both hit in same bar → loss). Timeout at `max_hold_days` → exit at that close.
- **Metrics**: win rate, avg R-multiple, Sharpe (mean R / std R), max drawdown (peak-to-trough of cumulative-R series), false-positive rate — per-ticker and overall.
- **Confidence-floor sweep**: every signal is recorded regardless of floor, so the interactive floor slider in the UI re-filters results instantly with no re-run. Includes a sweep chart (win-rate / avg-R / trade-count vs floor) to find the optimal `CONFIDENCE_FLOOR`.
- **Cumulative R-multiple chart** (dollar-free); $ equity curve + buy-and-hold benchmark are Phase 2.
- **LLM mode**: optional toggle; pre-flight quota notifier (est. requests/tokens/TPM/duration) + RPM/TPM throttle + scoped auto-fallback reading `llm_fallback_provider`/`llm_fallback_model` DB keys (shared with backlog item 3c).
- **Runs comparator**: multiselect past runs → side-by-side metrics + overlaid R curves.
- **New API**: `POST /backtest/stream` (SSE), `GET /backtest`, `GET /backtest/{id}`, `DELETE /backtest/{id}`.
- **New DB tables** (separate, never pollutes live `signals`): `backtest_runs`, `backtest_trades`; LLM token columns (`llm_calls`, `llm_prompt_tokens`, `llm_completion_tokens`, `llm_provider`, `llm_model`) and AI Review columns (`review_prompt_tokens`, `review_completion_tokens`) tracked per run.
- **New UI tab**: Backtesting (8 numbered sections); time-period presets `3M / 6M / 1Y / 2Y` + custom date pickers.
- **AI Review**: "Get AI Review" button on completed runs — sends metrics summary to the LLM; tokens tracked separately as `backtest_review` source in AI Usage.
- **AI Usage section** (Settings): renamed from "Token Usage"; period selector (Today / 3d / 7d / 30d / 90d); daily-calls bar chart; TPM headroom bar; cost estimate card; by-source breakdown (signals/explorer · backtesting runs · AI review); quota limits table per provider (Groq live headers, Gemini/Mistral documented free-tier limits).
- **Education**: two new wiki pages (`backtesting-explained.md`, `backtesting.md`) + Learn-tab section.

### Phase 2 — Virtual wallet simulation *(next item after Phase 1)*

- Start each run with a configurable virtual balance (e.g. `$10,000`)
- Each actionable signal opens a paper position: buy `N` shares at `entry`, set stop and target
- Close positions when price hits `target` (profit) or `stop` (loss); time-out after N days if neither hit
- Track running portfolio value day-by-day — visualise as a **$ equity curve** in the Backtest tab
- Compare against a simple buy-and-hold benchmark for the same period
- **Goal**: answer "if I had followed every signal for the last month, would I have made or lost money?"
- Layers on Phase 1 without schema changes — `initial_balance` + full `backtest_trades` (entry/exit/dates/direction) are already captured by Phase 1.

---

## 5. Trending ticker discovery (auto-detect, not manual add)

Surface *new* tickers to watch automatically from market trends, instead of relying only on manual watchlist additions.

- **Discovery sources**: top movers / most-active / unusual-volume (yfinance or the existing Finnhub integration), plus a momentum/trend screen (price above a rising EMA20/50, multi-timeframe RSI/MACD alignment) that reuses the current indicator stack.
- **Ranking**: score candidates by a trend/momentum score; show them in a "Trending" panel with the reason and a one-click **Add to watchlist**.
- **Optional auto-scan**: run the analysis pipeline on the top-N discovered tickers (respecting the orchestrator's concurrency cap) so signals appear without manual adds.
- **Config**: enable/disable, max candidates, refresh interval, minimum score.

Distinct from the existing manual `POST /watchlist` add flow — this is *discovery*, not curation.

---

## 6. Validate and clean up alert channels (Email + Telegram)

Slim the alert layer down to the two channels worth supporting, then validate them end-to-end.

### Step 1 — Remove Slack

- Delete `backend/alerts.py` Slack code path and `send_slack_alert()`
- Remove `SLACK_ENABLED` / `SLACK_WEBHOOK_URL` from `config.py`, `.env.example`, and all docs
- Update smoke test to no longer reference Slack

### Step 2 — Email (Gmail SMTP)

- Configure App Password on a test Gmail account
- Verify the formatted message (subject, body, entry/stop/target layout) arrives correctly
- Test both enabled and disabled states via `.env`

### Step 3 — Telegram

- Complete BotFather setup; document the two-step process (create bot → get chat ID)
- Verify delivery to a personal chat and a group chat (group chat IDs are negative numbers)
- Confirm the message format is readable on mobile

### Step 4 — Test endpoint + history

- Add `POST /alerts/test` endpoint that fires a dummy signal through all enabled channels — no need to wait for a real signal to verify credentials
- Add an `alert_log` table to the DB (channel, ticker, sent\_at, status) so the UI can show "last alert: Telegram · 2h ago"
- Add rate-limiting: skip re-alerting the same ticker + direction within a configurable cooldown window (default: 1h)

---

## ✅ News sentiment layer
*Shipped on branch `feat/backlog-4-backtesting-engine`*

- **Google News RSS** (always active, no API key) + **Finnhub** (optional) fetched and deduplicated per ticker per day
- **VADER** offline sentiment scoring per headline; aggregate score (−1.0 to +1.0) → Bullish / Bearish / Mixed / Neutral label
- **AI prompt injection**: `RECENT NEWS HEADLINES` block now includes `Aggregate sentiment: <label> (score=±X.XXX, n=N articles)` before individual headlines
- **Rule 7 — confidence adjuster**: ±1 pt (mild) or ±3 pts (strong) applied post-merge, direction-aware (bullish boosts long / hurts short; bearish reverses); Mixed/Neutral = no change
- **Explorer news card**: source, channel pill (Finnhub / Google News RSS), VADER label+score pill, date — all shown per headline
- **Opportunity score computation**: sentiment step added to formula display and All Rules table
- **Learn page**: Rule 7 card added to Section 5; Step 4 (sentiment) added to scoring pipeline in Section 6
- **Smoke tests Section 14**: 17 checks (empty-list graceful, positive/negative scoring, dedup, cap, filter direction, edge clamp, network graceful)

---

## Other ideas

- **Multi-model support** — allow swapping models per ticker or per scan type; benchmark `qwen2.5:14b` vs `llama3.1:8b` vs `mistral:7b` on accuracy/latency
- **Mobile notifications** — push via Pushover or ntfy.sh (self-hosted) as a lightweight alternative to Telegram
- **Confidence calibration** — track how often each confidence band (65–75 / 75–85 / 85+) leads to correct calls; auto-adjust `CONFIDENCE_FLOOR` over time
- **Dark-pool / options flow** — integrate unusual options activity data (e.g. Unusual Whales API) as an additional signal source


---

## Next up

- **Watchlist expansion** — support a larger, manageable set of tickers; add bulk-import and grouping (sector/theme)
- **Opportunity discovery** — scan beyond the existing watchlist for promising tickers; include filters/ranking and sensible API/LLM rate-limit controls so discovery runs don't exhaust quotas
- **Telegram integration** — deliver actionable notifications for new high-confidence signals, scan results, and paper-trading updates (fill/stop/target hit)
