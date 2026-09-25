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

## ✅ 3c. Multi-model fallback + cloud hosting (Vercel / Fly.io)

*Shipped on branch `feat/backlog-3c-fallback-hosting`*

Two closely related capabilities that build on item 3a and are best shipped together: automatic provider fallback when a quota is hit, and deploying the full stack publicly so it runs without a local machine.

**Delivered:**
- **Part 1** — fallback chain in `backend/analysis.py` (`llm_fallback_provider` / `llm_fallback_model` DB keys, `LLM_FALLBACK_PROVIDER` / `LLM_FALLBACK_MODEL` env fallbacks), exposed via `GET /settings` and `POST /settings/llm`.
- **Part 2** — backend on Fly.io (`fly.toml`, persistent volume at `/app/data`) and frontend on Vercel (`vercel.json`), with continuous deployment via `.github/workflows/deploy.yml` and one-time secret setup via `scripts/setup-gh-secrets.sh`. Documented in `docs/wiki/cloud-hosting.md`.

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

### ✅ Phase 2 — Virtual wallet simulation *(shipped)*

- Start each run with a configurable virtual balance (e.g. `$10,000`)
- Each actionable signal opens a paper position: buy `N` shares at `entry`, set stop and target
- Close positions when price hits `target` (profit) or `stop` (loss); time-out after N days if neither hit
- Track running portfolio value day-by-day — visualise as a **$ equity curve** in the Backtest tab
- Compare against a simple buy-and-hold benchmark for the same period
- **Goal**: answer "if I had followed every signal for the last month, would I have made or lost money?"
- Layers on Phase 1 without schema changes — `initial_balance` + full `backtest_trades` (entry/exit/dates/direction) are already captured by Phase 1.

---

## ✅ 5. Trending ticker discovery (auto-detect, not manual add)
*Shipped on branch `feat/backlog-5-trending-discovery`*

Surface *new* tickers to watch automatically from market trends, instead of relying only on manual watchlist additions.

- **Discovery sources**: Alpaca screener (`/v1beta1/screener/stocks/most-actives` + `/movers`) primary; yfinance predefined screeners (`day_gainers`, `most_actives`, `day_losers`) as fallback when Alpaca is unavailable or credentials are absent. Alpaca 403 (free-tier limit) caught at runtime — fallback is always exercised in tests.
- **Scoring**: deterministic 0-100 score — momentum (0-30), volume (0-25), trend alignment/EMA (0-25), multi-timeframe RSI/MACD (0-20). Reuses `compute_indicators()` (per-day cached); no LLM quota consumed.
- **Trending tab**: ranked candidate table, score bar chart (Recharts), one-click "Add to watchlist", refresh SSE stream with progress log.
- **Settings**: Discovery section in Settings panel + inline shortcut in Trending tab. All settings DB-backed (no restart needed): enable, sources, max_candidates, min_score, interval_minutes, autoscan_enabled, autoscan_top_n.
- **Optional auto-scan**: top-N above min_score run through full agent pipeline via `scan_ticker_async`; tickers **never auto-added** to watchlist (curation stays manual).
- **Scheduler integration**: discovery cycle fires after each watchlist scan, guarded by cooldown timer; `last_discovery` / `next_discovery` added to scheduler status.
- **Watchlist expansion**: `POST /watchlist/bulk` for bulk-import; `GET|POST|DELETE /watchlist/groups` for sector/theme grouping.
- **Persistence**: `discovery_runs`, `discovery_candidates`, `watchlist_groups` tables.
- **API**: `GET /discovery/trending`, `POST /discovery/refresh` (SSE), `GET|POST /settings/discovery`.
- **Docs**: `docs/wiki/trending-discovery.md`, `_Sidebar.md`, `README.md` features bullet.

---

## 6. Pluggable Notification & Alert Channel Integration

A channel-agnostic notification system that dispatches rich, actionable alerts across independently toggleable channels whenever a significant event occurs.

---

### Trigger events

| Event | When fired |
|---|---|
| **Discovery run completes** | Any `POST /discovery/refresh` SSE run finishes (scheduled or manual), regardless of candidate count |
| **Candidate score exceeds threshold** | A discovered candidate's score ≥ `discovery_min_score` (global setting) — one notification per ticker per run |
| **Order placed** | A paper or live order is submitted via the UI or the notification action button |
| **Order filled** | Alpaca webhook delivers a `fill` or `partial_fill` event for an open order |

---

### Message content

Every notification must include — at minimum:

- **Top-N candidates** (N configurable per channel): ticker symbol, score (0–100), % change, short reasons list
- **Run metadata**: source list (Alpaca / yfinance), total candidate count before and after scoring, timestamp
- **Current market status**: US market open/closed, closes/opens in Xh Ym
- Order notifications additionally include: direction (buy/sell), qty, fill price or limit price, order status

---

### Interactive actions (where the channel supports it)

| Channel | Supported action |
|---|---|
| Telegram | Inline keyboard buttons: **📄 Paper trade** / **💸 Live trade** — tapping routes the order through the existing order flow (`POST /paper/orders` or `/trade`), **not** a shortcut |
| Email | Deep link in the message body pointing to the Discovery tab with the candidate pre-selected |

Orders triggered by a notification **must** go through the same validation and confirmation path as the UI — no bypass of risk checks, no shortcut endpoints.

---

### Supported channels

| Channel | Default | Credentials |
|---|---|---|
| **Telegram** (bot) | Disabled | `bot_token`, `chat_id` |
| **Email** (SMTP) | Disabled | host, port, username, password, from-address, to-address |

The channel registry must be **extensible** — adding a third channel (e.g. Pushover, ntfy.sh, Slack) requires:
1. A new class implementing a `NotificationChannel` protocol (`.send(event, payload) → None`)
2. A new DB-backed config block in Settings
3. Zero changes to the core dispatch logic

---

### Architecture

```
NotificationDispatcher
  ├── TelegramChannel        (backend/notifications/telegram.py)
  ├── EmailChannel           (backend/notifications/email.py)
  └── <future channels>

backend/notifications/
  __init__.py        # NotificationChannel protocol + registry
  dispatcher.py      # dispatch(event, payload) — iterates enabled channels, isolates failures
  telegram.py        # BotFather bot, inline keyboard builder, callback handler for order actions
  email.py           # SMTP, Jinja2 HTML template
  templates/
    discovery.html   # Rich email template: top-N table, score bars, market status
    order.html       # Order confirmation / fill notice
```

`dispatch()` catches all per-channel exceptions — one failing channel must **never** block another or propagate to the caller (discovery run, webhook handler).

---

### Settings (per channel)

Configurable via the Settings page → new **Notifications** section and via DB-backed keys (no restart needed):

| Setting | Scope | Default |
|---|---|---|
| `notifications_enabled` | Global on/off | `false` |
| `telegram_enabled` | Channel toggle | `false` |
| `telegram_bot_token` | Telegram credential | `""` |
| `telegram_chat_id` | Telegram credential | `""` |
| `email_enabled` | Channel toggle | `false` |
| `email_smtp_host` | Email credential | `""` |
| `email_smtp_port` | Email credential | `587` |
| `email_username` | Email credential | `""` |
| `email_password` | Email credential | `""` (stored encrypted) |
| `email_from` | Email config | `""` |
| `email_to` | Email config | `""` |
| `notifications_top_n` | Per-channel override possible | `5` |
| `notifications_min_score` | Falls back to `discovery_min_score` | inherit |
| `notifications_cooldown_minutes` | De-dup same ticker + direction | `60` |

---

### API additions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/settings/notifications` | Return all notification settings (passwords masked) |
| `POST` | `/settings/notifications` | Update one or more settings |
| `POST` | `/notifications/test` | Fire a dummy event through all enabled channels — validate credentials without waiting for a real event |
| `GET` | `/notifications/log` | Paginated delivery history |
| `POST` | `/notifications/telegram/callback` | Webhook for Telegram inline-button responses (order actions) |

---

### DB additions

```sql
CREATE TABLE notification_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,            -- 'telegram' | 'email'
  event_type  TEXT NOT NULL,            -- 'discovery_complete' | 'candidate_scored' | 'order_placed' | 'order_filled'
  ticker      TEXT,                     -- NULL for run-level events
  payload     TEXT,                     -- JSON snapshot of what was sent
  status      TEXT NOT NULL,            -- 'sent' | 'failed'
  error       TEXT,                     -- error message on failure
  sent_at     TEXT NOT NULL             -- ISO-8601 UTC
);
```

The Settings / Notifications section shows a "Last sent" chip per channel (source: `notification_log`).

---

### Acceptance criteria

1. **Per-channel configurability** — every channel is independently enabled/disabled via Settings; credentials are validated lazily (on first send, not on save) and errors surface in `notification_log`
2. **Global min-score respected** — no notification fires for a candidate below `discovery_min_score`, even if the per-channel threshold is higher
3. **Order actions use the same flow** — Telegram inline-button taps call the identical `POST /paper/orders` (or live equivalent) endpoint as the UI; they go through the same validation, same Alpaca submission, same order-log persistence
4. **Channel failure isolation** — if Telegram is down, Email still fires; if both fail, the discovery run completes normally with errors recorded in `notification_log`
5. **Test endpoint** — `POST /notifications/test` must deliver a dummy notification to every enabled channel and return per-channel success/failure in the response body
6. **Cooldown de-dup** — the same ticker + direction does not trigger a second notification within the configured cooldown window (default 60 min), even across multiple discovery runs
7. **No Slack** — remove `send_slack_alert()`, `SLACK_ENABLED`, and `SLACK_WEBHOOK_URL` from `backend/alerts.py`, `config.py`, `.env.example`, and all docs before shipping this item

---

### Implementation order

1. **Housekeeping** — remove Slack code, update `.env.example` and docs
2. **Protocol + dispatcher** — `NotificationChannel`, `NotificationDispatcher`, `notification_log` table
3. **Email channel** — SMTP + HTML template; test via `POST /notifications/test`
4. **Telegram channel** — bot send; inline-keyboard builder; callback webhook for order actions
5. **Trigger wiring** — hook dispatcher into discovery SSE completion, score filter, Alpaca order webhook
6. **Settings UI** — Notifications section in Settings page; last-sent chips; test button
7. **Smoke tests** — mock channel adapters; verify isolation, cooldown, order routing, test endpoint

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

## ✅ 7. Sweet-Spot Refactor
*Shipped on branch `feat/backlog-7-sweet-spot-refactor` (PR #18)*

Split the largest files at clear responsibility boundaries to reach a shallow, moderate hierarchy. No new abstraction layers — the goal is readability, not over-engineering. Fewer files is better than more.

### Obvious starting points

| File | Current size | Problem |
|---|---|---|
| `frontend/src/App.jsx` | ~10 000 lines | All pages, all components, all state in one file |
| `backend/main.py` | ~2 500 lines | Every HTTP endpoint in one module |
| `tests/smoke/smoke_test.py` | ~1 800 lines | All 16 test sections in one flat script |

The review must cover the **whole project** — not just these three — but changes outside obvious hot-spots need a stronger justification.

### Rules

1. **Propose first, implement second.** Before writing any code, produce a target directory/file tree and wait for approval.
2. **Split only on clear responsibility boundaries.** A page component, a group of related endpoints, a test section — these are valid boundaries. "Too long" alone is not.
3. **No new abstraction layers.** No new base classes, no new shared utilities invented just to enable a split.
4. **Fewer files is better than more.** If a split produces a file under ~80 lines, reconsider whether the split is worth it.
5. **All existing tests must pass unchanged after every split.**

### Suggested split candidates (for discussion, not final)

- `frontend/src/App.jsx` → `src/pages/` (one file per page) + `src/components/` (shared UI) + `src/App.jsx` (routing/shell only)
- `backend/main.py` → `backend/routes/` (one module per feature group: analysis, discovery, paper, backtest, settings …) + `backend/main.py` (app creation + lifespan only)
- `tests/smoke/smoke_test.py` → `tests/smoke/` directory with one file per section group

---

## 8. Replace the in-process scheduler with a Cloudflare Workers cron trigger

The in-process `MonitorScheduler` (`backend/scheduler.py`) is a hand-rolled `while` loop that silently misses ticks whenever the backend restarts or Fly idles the machine (`fly.toml` sets `auto_stop_machines = "stop"` and `min_machines_running = 0`). Scans, the EoD digest, and the new LLM reports must fire on schedule regardless of backend uptime — so the trigger has to live *outside* the app it wakes up.

### Chosen approach — Cloudflare Workers Cron Triggers

**Decided.** A small Worker committed under `infra/cron-worker/` (`wrangler.toml` + a `scheduled` handler) `fetch()`es the authenticated backend endpoints — the scan trigger, `GET /reports/eod`, and `GET /reports/llm-summary` — on cron schedules. `ADMIN_TOKEN` is stored as a Worker secret (`wrangler secret put ADMIN_TOKEN`) and sent as the auth header the existing admin-token middleware already enforces. The handler adds a **market-hours guard** (skip weekends / holidays) and **retry-on-non-2xx**, so a cold Fly start is retried until the machine wakes instead of being silently dropped.

### Options considered

| Option | Decision | Why |
|---|---|---|
| **Cloudflare Workers cron** | **Chosen** | Free and runs independently of Fly uptime; a `scheduled` handler plus Worker secrets keep `ADMIN_TOKEN` off any third party; retries and logs are built in |
| GitHub Actions cron | Rejected | Scheduled workflows are frequently delayed or skipped under load, and already power `app-power.yml` — stacking scan/report timing on the same flaky scheduler compounds the risk |
| cron-job.org | Rejected | A third party would store the endpoint URL + `ADMIN_TOKEN`, against this project's self-hosted ethos |

### Acceptance criteria

1. Scans fire on schedule independent of backend uptime — a stopped or idled Fly machine is woken and scanned, never silently skipped
2. EoD and LLM reports fire on their cadences (close / daily / weekly)
3. Failed calls are retried and observable — every attempt and its outcome is visible in the Worker logs
4. `ADMIN_TOKEN` lives only in Worker secrets — never in `wrangler.toml`, the repo, or workflow YAML

### Implementation order

1. Scaffold the Worker — `infra/cron-worker/` with `wrangler.toml` + a `scheduled` handler
2. Wire the cron schedules for the scan trigger, `GET /reports/eod`, and `GET /reports/llm-summary`
3. Add the market-hours guard (skip weekends / holidays) + retry-on-non-2xx
4. Store the secret — `wrangler secret put ADMIN_TOKEN`
5. Migrate the scan / EoD triggers off `app-power.yml` onto the Worker
6. Document — `docs/wiki/` + `README.md`

`.github/workflows/app-power.yml` already demonstrates the cron-hits-an-authenticated-HTTP-endpoint-on-a-schedule pattern this Worker generalizes — it stops and starts the Fly machine on a fixed schedule via authenticated calls. Item 8 reuses that pattern for scan and report scheduling and retires the workflow's scheduling role.

---

## 9. Report comparator — week-over-week / arbitrary-period deltas

The four report types (`eod_frac`, `eod_orders`, `weekly_frac`, `weekly_orders`) each
summarise a **single** window: EoD = today, weekly = the last 7 days, plus some all-time
economics for context. None of them compares one period against another, so a weekly
report can say "P&L +$42 this week" but never "…up from -$18 last week." The "cross-week"
language in the weekly prompts refers to patterns *within* the current 7 days (signal
recurrence on 3+ days, streaks), not this-week-vs-last-week.

Goal: let the user see the **delta** between two periods — is performance improving or
regressing week over week, and on which metrics.

### The comparator — ad-hoc, pick any two reports

Pick any two **already-persisted** reports of the same type and diff them — "this week vs the
one before", or two arbitrary weeks the user selects. It's flexible (compare *any* two
periods), needs **no recompute** (reports already store structured metrics), and mirrors the
existing Backtest "runs comparator" (item 4).

Feasible because the `reports` table already persists a `context_json` column (structured,
numbers-only metrics — shipped on `feat/reports-split-llm-config-revamp`). The comparator
diffs two stored blobs with **no data re-query**.

The feature has **two layers** — a fast deterministic diff, and an LLM "trading master" review
layered on top.

### Layer 1 — Plain, non-LLM delta (quick glance)

No LLM call. Diffs two stored reports and renders side-by-side deltas across **two dimensions**:

- **Performance metrics** — P&L, win rate, closed trades, signals count, budget/position cap
  hits, top movers. Show value A, value B, absolute Δ and %Δ with up/down colour.
- **Configuration / tuning deltas** — the effective tuning knobs at each report's generation
  time (e.g. `FRAC_BUDGET 100 → 150`, `FRAC_MIN_CONFIDENCE 85 → 80`). This is what makes the
  comparison *causal* rather than just descriptive: the user sees which settings changed
  between the two windows alongside how performance moved.

This layer alone answers "what changed, and did my last tweak help?" at a glance, offline.

### Layer 2 — "Super trading master" LLM review

A one-click review that sends both periods' metrics **and** their config deltas to the LLM,
asking it to act as an expert trading coach and return actionable judgement, not just narration:

- **What's good** — metrics that improved and are worth keeping / doubling down on.
- **What's bad** — regressions and their likely cause (often tied to a config change).
- **What to improve** — concrete, specific suggestions with proposed setting values
  (e.g. "win rate rose but trade count halved after `FRAC_MIN_CONFIDENCE 85→80` — try 82 to
  recover volume without giving back the quality gain").

Uses the mode-scoped tuning knobs already built for the reports (frac reports only suggest
frac vars, orders only bracket vars). Tokens tracked as a new `report_compare` source in AI
Usage (same pattern as `backtest_review`). The review is on-demand — never fires automatically.

### Design sketch

- **API** —
  - `GET /reports/compare?a=<report_id>&b=<report_id>` → deterministic metric + config deltas
    from each report's `context_json`. Reject the pair if `type` differs (can't compare a frac
    report against an orders report).
  - `POST /reports/compare/review` (body: the two ids) → the LLM trading-master analysis.
- **UI** — Reports page: multiselect two report cards of the same type → comparison view with
  a metric delta table, a config delta table, and a "Get trading-master review" button that
  renders the LLM verdict (good / bad / improve sections). Reuse the Backtest runs-comparator layout.

### Acceptance criteria

1. Any two same-type persisted reports can be compared; mismatched types are rejected with a clear error.
2. Layer 1 shows value A, value B, absolute Δ and %Δ for every shared metric **and** a config-delta table of changed tuning knobs — with **no LLM call**.
3. Selecting "this week" + "previous week" of the same type reproduces a week-over-week view.
4. Layer 2 review returns explicit **good / bad / improve** sections with concrete suggested setting values, scoped to the report's flow (frac vs orders), and only when explicitly requested.
5. Config deltas correctly reflect the tuning values in effect when each report was generated (not the current live values).

### Dependencies / prerequisites

- Relies on `reports.context_json` being populated — shipped on `feat/reports-split-llm-config-revamp`. Pre-migration reports have no `context_json` and can't be compared (surface them as "no structured data" in the picker).
- **Config deltas require a config snapshot per report.** Today `context_json` stores metrics but not the effective tuning knobs. Prerequisite: persist the `_current_tuning(mode)` snapshot into each report's `context_json` (or a sibling column) at generation time, so historical comparisons show the settings that were actually in force — not the current live values.

---

## Other ideas

- **Multi-model support** — allow swapping models per ticker or per scan type; benchmark `qwen2.5:14b` vs `llama3.1:8b` vs `mistral:7b` on accuracy/latency
- **Mobile notifications** — push via Pushover or ntfy.sh (self-hosted) as a lightweight alternative to Telegram
- **Confidence calibration** — track how often each confidence band (65–75 / 75–85 / 85+) leads to correct calls; auto-adjust `CONFIDENCE_FLOOR` over time
- **Dark-pool / options flow** — integrate unusual options activity data (e.g. Unusual Whales API) as an additional signal source
