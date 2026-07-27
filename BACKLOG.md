# Backlog — offgrid-trader

Future ideas and planned improvements. No priority order within each item.

---

## 0. Architecture diagrams

Create diagrams to make the system easier to understand at a glance.

- **Pipeline diagram** — ticker → data fetch → Ollama analysis → opportunity detection → save → alert
- **Infrastructure diagram** — Docker Compose services, ports, shared `ai-shared` network, volumes
- **Data-flow diagram** — how market data maps to indicators, how AI JSON maps to opportunities
- Tooling candidates: Mermaid (renders in GitHub), draw.io, or C4 model

---

## 1. Agentic architecture — workers and skills

Replace the monolithic scan loop with a proper agent framework.

- **Worker per ticker** — each ticker runs as an independent agent; agents can be paused, retried, or scaled
- **Skill modules** — separate pluggable skills: `fetch_data`, `technical_analysis`, `ai_analysis`, `risk_score`, `opportunity_detect`, each composable and individually testable
- **Orchestrator agent** — coordinates workers, respects rate limits, prioritises watchlist by volatility or news events
- **Memory layer** — agents remember prior analysis for a ticker so reasoning can be contextual ("RSI was oversold yesterday and is still oversold today → stronger signal")
- **Tool-use loop** — give the LLM access to tools (fetch price, read DB, query news) and let it reason in multiple steps before producing a signal
- Potential frameworks: LangGraph, CrewAI, or a lightweight custom loop using Ollama tool-call support

---

## 2. Backtesting / simulation evaluation

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

## 3. Alert integrations — setup and end-to-end testing

The alert channels (email, Slack, Telegram) are coded but need real end-to-end validation.

- **Email (Gmail SMTP)**: configure App Password, test with a real address, verify formatting
- **Slack**: set up an Incoming Webhook in a test workspace, confirm message arrives with correct layout
- **Telegram**: complete BotFather setup, verify group-chat delivery (chat IDs differ for groups vs DMs)
- Add a `/api/alerts/test` endpoint that fires a dummy alert through all configured channels — useful for verifying credentials without waiting for a real signal
- Add an alert history table to the DB so the UI can show "last alert sent: 2h ago via Telegram"
- Consider rate-limiting: don't flood channels with repeated alerts for the same ticker/direction within a cooldown window

---

## 4. TradingView integration

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
