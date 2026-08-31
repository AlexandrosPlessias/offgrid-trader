# Paper Trading — Alpaca

MarketSage connects to **Alpaca's free paper-trading environment** so every
actionable signal automatically places a real bracket order on a virtual $100 k
account. No real money is involved — it is a free simulation that uses the same
REST API and market data as a live account.

> ⚠️ **Not financial advice.** For educational and research use only.
> Paper trading results do not guarantee identical live results.

---

## Quick start

1. Create a free account at [app.alpaca.markets](https://app.alpaca.markets/paper-trading) and navigate to **Paper Trading → API Keys**.
2. Copy your **Key ID** and **Secret Key**.
3. Open **Settings → 📈 Paper Trading** in MarketSage, paste the credentials, and click **Save & Test Connection**. The account equity appears on success.
4. Enable the **Paper trading enabled** toggle and set your **position size** (default $500).
5. Wait for the next scheduled scan (or trigger one via the Dashboard **Run** button) — orders appear in the Paper Orders sidebar automatically.

---

## How it works end-to-end

```
Scheduler scan
    → TickerAgent pipeline
        → PaperTradeSkill
              ├── for each actionable opportunity:
              │     check signal confidence ≥ min_confidence threshold
              │     check no open/pending order already exists for this signal
              │     POST /v2/orders (market bracket — stop-loss + take-profit)
              │     save to paper_orders table
              └── return orders_placed list

After scan loop:
    → sync_paper_orders()
          GET /v2/orders (status=all, limit=200)
          update paper_orders table (status, filled_qty, filled_avg_price, P&L)
```

### Bracket order structure

Each order is placed as a **market order with attached bracket legs**:

| Field | Source |
|---|---|
| Symbol | ticker from signal |
| Notional | `paper_trade_position_size` setting (e.g. $500) |
| Side | `buy` (long) / `sell` (short) |
| Type | `market` — fills immediately at open |
| Time in force | `day` — expires at market close if unfilled |
| Stop-loss price | signal's `stop` price |
| Take-profit price | signal's `target` price |

Alpaca handles fractional shares automatically so any notional amount is valid.

### Deduplication

`PaperTradeSkill` skips a signal if an order already exists for the same `signal_id` in `paper_orders` with status `pending`, `accepted`, or `filled`. This prevents double-ordering when the same signal fires across consecutive scans.

---

## Live market data

The Dashboard **Watchlist** shows a live price table, separate from the paper order flow:

| Column | Source |
|---|---|
| Price | `dailyBar.c` (latest daily close) |
| Chg% | `(dailyBar.c − prevDailyBar.c) / prevDailyBar.c × 100` |
| VWAP | `dailyBar.vw` |
| Vol | `dailyBar.v` |
| H / L | `dailyBar.h` / `dailyBar.l` |
| Last | timestamp of the latest trade |

Prices are fetched from **`data.alpaca.markets`** (Alpaca's market data host, separate from the trading host). The same API key is used for both.

**Market-hours gating:**
- When the market is open: prices refresh every **30 seconds**.
- When the market is closed: one initial fetch shows last-session prices; polling stops. The watchlist header shows "⚫ market closed · prices from last session".

The AI signal scan in the scheduler also only runs during market hours — both are gated by the same `is_market_open()` check.

---

## Paper Orders sidebar

The collapsible left panel on the Dashboard shows:

| Section | Data |
|---|---|
| **Account** | Equity, Day P&L (Δ$ and Δ%), Cash, Buying Power, Long Market Value, Margin used, Day-trade count |
| **Market clock** | Open/Closed pill with next open/close time |
| **Open Positions** | Live from `GET /v2/positions` — ticker, side, market value, unrealised P&L |
| **Recent Orders** | From local DB — status chip (colour-coded), notional, filled avg price, signal link |

Orders can be cancelled directly from the sidebar — the cancel button calls `POST /paper/orders/{id}/cancel` which deletes the Alpaca order and updates the local status.

The panel state (open/collapsed) persists to `localStorage`.

---

## Settings reference

| Setting | `.env` key | Default | Description |
|---|---|---|---|
| Paper API URL | `ALPACA_PAPER_URL` | `https://paper-api.alpaca.markets` | Override for non-standard Alpaca regions. Trailing `/v2` stripped automatically. |
| API Key ID | `ALPACA_API_KEY_ID` | *(unset)* | Alpaca key ID (visible in Settings as a masked field). |
| API Secret Key | `ALPACA_API_SECRET_KEY` | *(unset)* | Alpaca secret — never returned by the API; stored encrypted-at-rest in the DB. |
| Paper trading enabled | DB only | `false` | Master toggle. When off, `PaperTradeSkill` skips order placement but the data panel remains active. |
| Position size | DB only | `500` | Notional $ per bracket order. |
| Min confidence | DB only | *(signal floor)* | Minimum confidence specifically for auto-trading. Defaults to the global `CONFIDENCE_FLOOR` if unset. |

`.env` values act as defaults; values saved via the Settings page are stored in SQLite and take precedence. Click **Load .env defaults** on the Settings page to revert to env values.

---

## API endpoints

All `/paper/*` endpoints are documented in [api.md](api.md#paper-trading-alpaca). Quick reference:

| Method | Path | Description |
|---|---|---|
| `GET` | `/paper/account` | Live Alpaca account summary |
| `GET` | `/paper/orders` | Local DB paper orders (most recent first) |
| `GET` | `/paper/positions` | Live open positions from Alpaca |
| `POST` | `/paper/orders/{id}/cancel` | Cancel a pending order |
| `POST` | `/paper/sync` | Manual order-status poll |
| `GET` | `/paper/clock` | Alpaca market clock (is_open, next_open, next_close) |
| `GET` | `/paper/history` | Portfolio equity curve |
| `GET` | `/paper/market/snapshots` | Live price snapshots for watchlist tickers |
| `POST` | `/settings/alpaca` | Save credentials + settings |
| `POST` | `/settings/alpaca/test` | Test credentials without saving |

---

## Limitations

| Item | Detail |
|---|---|
| Starting balance | Alpaca always resets paper accounts to $100 k. Changing it requires using the Alpaca web dashboard (or closing and reopening the paper account). |
| Historical bars | Alpaca free tier does not provide historical OHLCV bars; `GET /v2/stocks/{ticker}/bars` returns `null`. Snapshots (used for the watchlist) work fine. |
| 1H data window | yfinance 1H data goes back ~730 days. Backtesting windows older than that fall back to daily-bar rules. |
| Fractional shares | Supported for US equities on Alpaca paper. Crypto and some ETFs may require whole shares. |
| Market hours | US equities only (9:30–16:00 ET, Mon–Fri). Extended-hours orders are not placed. |
