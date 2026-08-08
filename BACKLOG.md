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

## 0b. Architecture diagrams

Create diagrams to make the system easier to understand at a glance for developers.

- **Pipeline diagram** — ticker → data fetch → Ollama analysis → opportunity detection → save → alert
- **Infrastructure diagram** — Docker Compose services, ports, shared `ai-shared` network, volumes
- **Data-flow diagram** — how market data maps to indicators, how AI JSON maps to opportunities
- Tooling candidates: Mermaid (renders in GitHub), draw.io, or C4 model

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

- `pandas-ta` indicator values may differ slightly from TradingView's (different lookback defaults). Thresholds in `opportunities.py` may need minor tuning after the switch — run the backtest item (#3) to validate.
- `yfinance` does not officially support a `4h` interval on all tickers; use `2h` as a fallback or derive from `1h` bars.
- Polygon.io free tier data is delayed (~15 min) and rate-limited — suitable only as a fallback or for end-of-day backtesting, not real-time scanning.
- If Finnhub API key is absent, the system falls back to the current behaviour (no news); this is a zero-config backward-compatible change.

---

## 2. Agentic architecture — workers and skills

Replace the monolithic scan loop with a proper agent framework.

- **Worker per ticker** — each ticker runs as an independent agent; agents can be paused, retried, or scaled
- **Skill modules** — separate pluggable skills: `fetch_data`, `technical_analysis`, `ai_analysis`, `risk_score`, `opportunity_detect`, each composable and individually testable
- **Orchestrator agent** — coordinates workers, respects rate limits, prioritises watchlist by volatility or news events
- **Memory layer** — agents remember prior analysis for a ticker so reasoning can be contextual ("RSI was oversold yesterday and is still oversold today → stronger signal")
- **Tool-use loop** — give the LLM access to tools (fetch price, read DB, query news) and let it reason in multiple steps before producing a signal
- Potential frameworks: LangGraph, CrewAI, or a lightweight custom loop using Ollama tool-call support

---

## 3. Backtesting / simulation evaluation

Evaluate how good the model's decisions actually are against historical data.

- **Scenario**: pick a past month (e.g. June 2026), replay tick-by-tick or day-by-day as if it were live
- Feed historical OHLCV + indicator data through the same pipeline that runs today
- Record every signal the system would have generated
- Compare against actual subsequent price movements: did the entry/stop/target play out?
- **Metrics**: win rate, average R-multiple, Sharpe ratio of simulated trades, false-positive rate
- **Output**: a report card per ticker and overall — useful for tuning `CONFIDENCE_FLOOR` and prompt

Implementation notes:
- `yfinance` supports historical data; backfill `tradingview-ta` or compute indicators manually
- Add a `--backtest` mode to `backend/scheduler.py` that replays a date range instead of scanning live
- Store backtest runs in a separate SQLite table so results don't pollute live `signals`

---

## 4. Alert integrations — setup and end-to-end testing

The alert channels (email, Slack, Telegram) are coded but need real end-to-end validation.

- **Email (Gmail SMTP)**: configure App Password, test with a real address, verify formatting
- **Slack**: set up an Incoming Webhook in a test workspace, confirm message arrives with correct layout
- **Telegram**: complete BotFather setup, verify group-chat delivery (chat IDs differ for groups vs DMs)
- Add a `/api/alerts/test` endpoint that fires a dummy alert through all configured channels — useful for verifying credentials without waiting for a real signal
- Add an alert history table to the DB so the UI can show "last alert sent: 2h ago via Telegram"
- Consider rate-limiting: don't flood channels with repeated alerts for the same ticker/direction within a cooldown window

---

## 5. TradingView integration

Wire up TradingView Pro alerts to trigger analysis automatically.

- **Webhook endpoint** (`POST /webhook/tradingview`) is already implemented — needs real-world testing with a Pro/Essential account
- **Alert setup guide**: document the exact JSON payload format to use in TradingView's alert message body:
  ```json
  { "ticker": "{{ticker}}", "action": "{{strategy.order.action}}", "price": {{close}} }
  ```
- **ngrok / Cloudflare Tunnel**: the webhook needs a public URL; add setup instructions for exposing the local backend during development
- **Condition mapping**: map TradingView's `buy`/`sell` action strings to `long`/`short` in the webhook handler
- **Two-way flow**: optionally push signals back to TradingView via `strategy.alert()` calls for visual confirmation on the chart
- Document required TradingView account tier (Essential or above for webhook alerts)

---

## Other ideas

- **News sentiment layer** — fetch recent headlines for a ticker (e.g. via `feedparser` + Google News RSS) and include a sentiment summary in the Ollama prompt
- **Multi-model support** — allow swapping models per ticker or per scan type; benchmark `qwen2.5:14b` vs `llama3.1:8b` vs `mistral:7b` on accuracy/latency
- **Mobile notifications** — push via Pushover or ntfy.sh (self-hosted) as a lightweight alternative to Telegram
- **Confidence calibration** — track how often each confidence band (65–75 / 75–85 / 85+) leads to correct calls; auto-adjust `CONFIDENCE_FLOOR` over time
- **Dark-pool / options flow** — integrate unusual options activity data (e.g. Unusual Whales API) as an additional signal source
