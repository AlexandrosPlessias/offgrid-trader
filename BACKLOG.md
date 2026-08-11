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

## 1. Replace tradingview-ta with a free, open-source indicator stack

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

## 2. Low-cost / zero-cost cloud LLM hosting

Replace (or complement) local Ollama with a free or near-free cloud inference API so the app can run without a beefy local machine (no 16 GB RAM, no GPU required).

**Core idea:** decouple AI inference from the local stack. The backend already calls Ollama over HTTP — pointing it at a cloud-compatible, OpenAI-style API endpoint is a small code change.

### Candidate providers

| Provider | Model(s) | Free tier | Notes |
|---|---|---|---|
| **Groq Cloud** | Qwen 2.5 32B, Llama 3.1 70B | ~30 req/min, no card | Fastest inference available; OpenAI-compatible; strong free tier |
| **SambaNova Cloud** | Qwen 2.5 72B, Llama 3.1 405B | Generous free tier | Very fast; OpenAI-compatible |
| **Together AI** | Qwen 2.5, many others | Pay-per-token (cheap) | Reliable; good for volume above free-tier limits |
| **Replicate / RunPod** | Any model via vLLM | Pay-per-second GPU | More DevOps; skip unless others don't cut it |

Groq or SambaNova are the preferred starting point — free, fast, no credit card required.

### App hosting (if deploying publicly)

| Layer | Option | Notes |
|---|---|---|
| Frontend | **Vercel** (free) | Vite SPA — ideal fit |
| Backend + scheduler | **Fly.io** free tier | Never sleeps; supports persistent volumes for SQLite; better than Render (which sleeps after 15 min) |
| SQLite persistence | Fly.io persistent volume | Mount at `/data`; survives redeploys |

### What changes in the code

- `backend/analysis.py` — replace `requests.post(ollama_chat_url)` with an OpenAI-SDK call (`openai.chat.completions.create`) pointed at the chosen provider's base URL
- `backend/config.py` — add `LLM_PROVIDER` (`ollama` / `groq` / `sambanova`), `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`; make Ollama the default so existing local setups are unchanged
- `.env.example` — document the new env vars
- `docker-compose.yml` — make `ollama` service optional (skip if `LLM_PROVIDER != "ollama"`)
- `SETUP.md` — add "Cloud AI" quick-start path alongside the existing local Ollama path

### Open questions (revisit before implementing)

- Rate limits on free tiers vs. scan frequency: `SCAN_INTERVAL_MINUTES × len(WATCHLIST)` calls/hour — verify each provider's limits before committing
- Privacy: ticker data + market snapshots leave the machine. Document this trade-off clearly.
- SSE streaming: cloud providers return streamed chunks via the OpenAI streaming API — wire that through to the existing SSE endpoint for consistent UX
- Backlog item 1 (pandas-ta) should ideally land first — fewer external dependencies before adding a new one

---

## 3. Agentic architecture — workers and skills

Replace the monolithic scan loop with a proper agent framework.

- **Worker per ticker** — each ticker runs as an independent agent; agents can be paused, retried, or scaled
- **Skill modules** — separate pluggable skills: `fetch_data`, `technical_analysis`, `ai_analysis`, `risk_score`, `opportunity_detect`, each composable and individually testable
- **Orchestrator agent** — coordinates workers, respects rate limits, prioritises watchlist by volatility or news events
- **Memory layer** — agents remember prior analysis for a ticker so reasoning can be contextual ("RSI was oversold yesterday and is still oversold today → stronger signal")
- **Tool-use loop** — give the LLM access to tools (fetch price, read DB, query news) and let it reason in multiple steps before producing a signal
- Potential frameworks: LangGraph, CrewAI, or a lightweight custom loop using Ollama tool-call support

---

## 4. Backtesting + virtual wallet simulation

Evaluate how good the system's signals actually are by replaying them against historical data and tracking a simulated portfolio.

### Backtesting engine

- **Scenario**: pick a date range (e.g. the last 3 months), replay day-by-day as if it were live
- Feed historical OHLCV + indicator data through the same pipeline that runs today
- Record every signal the system would have generated on each day
- Compare against actual subsequent price movements: did the entry/stop/target play out before the opposite level was hit?
- **Metrics**: win rate, average R-multiple, Sharpe ratio, max drawdown, false-positive rate
- **Output**: a report card per ticker and overall — useful for tuning `CONFIDENCE_FLOOR` and prompt wording

### Virtual wallet

- Start each backtest run with a configurable virtual balance (e.g. `$10,000`)
- Each actionable signal opens a paper position: buy `N` shares at `entry`, set stop and target
- Close positions when price hits `target` (profit) or `stop` (loss); time-out after N days if neither hit
- Track running portfolio value day-by-day — visualise as an equity curve in the Explorer or a new Backtest tab
- Compare against a simple buy-and-hold benchmark for the same period
- **Goal**: answer "if I had followed every signal for the last month, would I have made or lost money?"

### Implementation notes

- `yfinance` historical download covers the replay period; indicators computed with `pandas-ta` (item 1)
- Add a `POST /backtest` endpoint (or a CLI flag `--backtest`) that accepts `{ tickers, start_date, end_date, initial_balance }`
- Store backtest runs in a separate `backtest_runs` + `backtest_trades` SQLite table — never pollutes live `signals`
- Item 1 (pandas-ta) must land first — needed to recompute indicators historically without TradingView dependency

---

## 5. Validate and clean up alert channels (Email + Telegram)

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

## Other ideas

- **News sentiment layer** — fetch recent headlines for a ticker (e.g. via `feedparser` + Google News RSS) and include a sentiment summary in the Ollama prompt
- **Multi-model support** — allow swapping models per ticker or per scan type; benchmark `qwen2.5:14b` vs `llama3.1:8b` vs `mistral:7b` on accuracy/latency
- **Mobile notifications** — push via Pushover or ntfy.sh (self-hosted) as a lightweight alternative to Telegram
- **Confidence calibration** — track how often each confidence band (65–75 / 75–85 / 85+) leads to correct calls; auto-adjust `CONFIDENCE_FLOOR` over time
- **Dark-pool / options flow** — integrate unusual options activity data (e.g. Unusual Whales API) as an additional signal source
