# Trading — Alpaca

MarketSage connects to **Alpaca** and offers two independent trading engines,
shown as tabs on the **Trading** page:

- **📈 Order Trading** — whole-share **bracket** orders (entry + stop + take-profit)
  on the primary Alpaca **paper** account. This is the original simulation engine
  documented in most of this page.
- **🪙 Fractional Trading** — **notional** fractional buys (e.g. $15 of a stock) on a
  **second, separately-credentialed** Alpaca profile. Designed for a small
  **real-money** budget: monitor on paper, then flip that profile's host to live.
  See [Fractional Trading](#fractional-trading-real-money) below.

No real money is involved in Order Trading — it is a free simulation that uses the
same REST API and market data as a live account.

> ⚠️ **Not financial advice.** For educational and research use only.
> Paper trading results do not guarantee identical live results. Fractional Trading
> can place **real-money** orders once you point its profile at the live host.

---

## Quick start

1. Create a free account at [app.alpaca.markets](https://app.alpaca.markets/paper-trading) and navigate to **Paper Trading → API Keys**.
2. Copy your **Key ID** and **Secret Key**.
3. Open **Settings → 📈 Paper Trading** in MarketSage, paste the credentials, and click **Save & Test Connection**. The account equity appears on success.
4. Enable the **Paper trading enabled** toggle and set your **position size** (default $500).
5. Wait for the next scheduled scan (or trigger one via the Dashboard **Run** button) — orders appear on the **Trading** page automatically.

> **Tip:** Open the **Trading** tab in the top nav to see your full account overview,
> charts, open positions, and all orders in one place.

---

## How it works end-to-end

```
Scheduler scan
    → TickerAgent pipeline
        → PaperTradeSkill
              ├── for each actionable opportunity:
              │     check signal confidence ≥ min_confidence threshold
              │     check no open order already exists for this ticker+side
              │     check notional ≥ 1 whole share at current price
              │     compute qty = floor(notional / entry_price)  (minimum 1)
              │     POST /v2/orders (market bracket — stop-loss + take-profit)
              │     round stop/take-profit to 2 decimal places (Alpaca requirement)
              │     save to paper_orders table
              └── return orders_placed list

After scan loop:
    → sync_paper_orders()
          GET /v2/orders (status=all, limit=200)
          update paper_orders table (status, filled_qty, filled_avg_price, P&L)
```

### Bracket order structure

Each order is a **market order with attached bracket legs** using **whole shares**
(Alpaca does not allow fractional shares on bracket orders).

| Field | Source |
|---|---|
| Symbol | ticker from signal |
| Qty | `floor(position_size / entry_price)` — whole shares, minimum 1 |
| Side | `buy` (long) / `sell` (short) |
| Type | `market` — fills immediately at open |
| Time in force | `day` — expires at market close if unfilled |
| Stop-loss price | signal's `stop` price, rounded to 2 dp |
| Take-profit price | signal's `target` price, rounded to 2 dp |

> **Important:** Alpaca rejects `notional` (fractional) amounts for bracket orders
> (`"fractional orders must be simple orders"`). All bracket orders use `qty`
> (whole shares). Sub-penny stop/take-profit prices are also rejected — the app
> rounds both to 2 decimal places automatically.

#### High-price stock guard

If `floor(position_size / price) = 0` (e.g. $500 budget for a $958 stock),
the order is **skipped** rather than buying 1 share and overshooting the budget.
The scheduler logs a warning; the manual "Place Paper Order" button returns a
clear error message. Increase your position size in Settings if you want to trade
high-priced stocks.

### Deduplication

Orders are blocked if **either** of these conditions is true:

1. An existing `paper_orders` row links the same `signal_id` (exact match).
2. A non-terminal order (not cancelled/expired/filled) already exists for the same `ticker + side` combination — prevents accumulating multiple positions from repeated scans.

---

## Manual order placement

In addition to automatic placement by the scheduler, you can place orders manually
from two places:

### Signal cards (Dashboard)

Every signal card has a **📈 Place Paper Order** button (centred, bottom of the
card) when the signal has valid stop and target prices. After clicking:

- **While placing:** button shows `⏳ Placing…`
- **On success:** button is replaced by `✓ Order placed`
- **If already exists:** `ℹ Order already exists` (dedup blocked it)
- **If budget too small:** red error with the minimum required amount
- **If order pre-exists in DB:** the button is replaced by a disabled status badge showing the current order status (e.g. `📋 PENDING NEW`)

The signal card also shows a **🤖 LLM** or **📐 Rules** badge in the source chip
row to indicate whether the signal was generated by the AI model or by rule-based
detection only.

### Explorer — Section 7 (Signals detected)

The Analysis Explorer's step-by-step walkthrough includes a "Place" button on
**every** signal row in Section 7, including signals below the confidence floor.
Below-floor buttons are shown in a dimmed style with a tooltip indicating they are
sub-floor.

### API endpoint

```http
POST /paper/orders/place
Authorization: Bearer <token>
Content-Type: application/json

{
  "ticker": "NVDA",
  "side": "buy",
  "entry": 226.05,
  "stop": 219.26,
  "target": 239.61,
  "notional": 500,      // optional — defaults to Settings position size
  "signal_id": 42       // optional — used for dedup
}
```

Returns `{"placed": true, "alpaca_order_id": "...", "status": "accepted"}` or
`{"placed": false, "reason": "order_exists"|"ticker_open"}`.

---

## Trading page

The dedicated **Trading** tab (top navigation bar) has two sub-tabs:
**📈 Order Trading** (this section) and **🪙 Fractional Trading**
(see [Fractional Trading](#fractional-trading-real-money)). The Order Trading tab
is the primary paper-trading dashboard. It shows:

### Account metrics

Four tiles: **Portfolio Value · Day P&L · Cash · Buying Power**.

> Buying Power = 4× equity on Alpaca margin accounts. With a $100 k account you
> see $400 k buying power. Each $500 bracket order uses only a small fraction of it.

### Portfolio equity curve

1-month area chart pulled from `GET /paper/history`. Shows cumulative equity
growth vs. starting value (dashed baseline). Green = above baseline, red = below.

### Insight charts

Shown as soon as at least one order exists:

| Chart | Description |
|---|---|
| **Orders by Status** | Donut: pending, filled, cancelled, etc. |
| **Max Gain / Max Loss per Order** | Grouped bar chart (green = max gain, red = max loss per order). Footer row shows **cumulative totals** and **net** across all open orders. |
| **Signal Confidence per Order** | Bar chart colour-coded by confidence band (green ≥ 85%, yellow ≥ 75%, red < 75%). Dashed line marks the confidence floor. |
| **Realised P&L** (closed orders) | Area chart of **cumulative** P&L over time with 7D / 30D / 90D / All filter. Summary row shows trade count and total P&L. |
| **Realised P&L by Ticker** (closed) | Bar per ticker, green/red. |
| **Win / Loss donut** (closed) | Win rate percentage. |

The last three charts (realised) only appear once orders have been filled and closed.

### Open Positions

Live from Alpaca `GET /v2/positions`: Ticker · Side · Qty · Avg Entry · Current
Price · Market Value · Unrealised P&L · P&L %.

### Orders table

All local DB orders (up to 200, filter: **All / Open / Filled / Cancelled**).

| Column | Description |
|---|---|
| ▸ / ▾ | Click any row to expand its full detail panel |
| Direction | ▲ LONG / ▼ SHORT |
| Status | Current order state. See [Understanding order statuses](#understanding-order-statuses) below for a plain-English guide to every possible value. |
| Position Size | Whole shares + actual cost (e.g. `2 shares / $452.10`). Tooltip shows target notional. |
| Entry | Signal entry price |
| Stop | Red stop price + **−$XX max loss** below |
| Take Profit | Green target price + **+$XX max gain** below |
| Filled @ | Fill price + **R:R X×** ratio |
| Realised P&L | Green/red after close |
| Conf % | Signal confidence |
| Source | Each source on its own line (ai / macd_crossover / …) |
| Placed | Date on line 1, time on line 2 |
| Cancel | Button for open orders only |

#### Understanding order statuses

When you place a paper trade, it does not execute instantly — it goes on a journey. You submit a request; the exchange puts it in a queue; from there it either fills (gets bought or sold at the market) or it does not (cancelled by you, or expired at market close). The table below shows every status label the app can display, in the order you are likely to see them.

| Status | Plain-English label | What it means |
|---|---|---|
| `pending_new` | Waiting to be sent | Your request is on its way to the exchange — nothing has happened yet. |
| `accepted` / `held` | In the queue | The exchange received it and is waiting for the right moment to act. |
| `partially_filled` | Half done | Some shares were bought or sold, but the rest is still waiting. |
| `filled` | Done ✓ | All shares bought or sold. The "Filled @" price is what you actually paid or received. |
| `cancelled` | Cancelled | Called off before it could complete. Nothing was bought or sold. |
| `expired` | Ran out of time | Day orders automatically cancel at market close if they were not filled — like a shop closing before you reached the till. |

#### Expanded row

Click `▸` to open a 3-section detail panel separated by vertical dividers:

- **Trade Math** — Shares, Actual invested, Risk/share, Reward/share, Max loss, Max gain, R:R
- **Order** — Alpaca ID, Signal ID, Placed, Filled, Closed timestamps
- **Signal** — Confidence %, Mode (🤖 LLM / 📐 Rules), Sources (stacked), Signal timestamp

---

## Paper Orders sidebar (Dashboard)

The collapsible left panel on the Dashboard remains for quick glances:

| Section | Data |
|---|---|
| **Auto-trading status** | Green badge (enabled) or red badge (disabled) — links to Settings |
| **Account** | Equity, Day P&L, Cash, Buying Power |
| **Recent Orders** | Up to 20 most recent — click any row to jump to the **Trading** page with that order pre-expanded |

Orders in the sidebar are **clickable** — clicking navigates to the Trading tab and
automatically scrolls to and expands the matching order row.

The panel state (open/collapsed) persists to `localStorage`.

---

## Settings reference

| Setting | `.env` key | Default | Description |
|---|---|---|---|
| Paper API URL | `ALPACA_PAPER_URL` | `https://paper-api.alpaca.markets/v2` | Must include `/v2`. Without it the account endpoint returns empty data. |
| API Key ID | `ALPACA_API_KEY_ID` | *(unset)* | Alpaca key ID (set-only from the UI). |
| API Secret Key | `ALPACA_API_SECRET_KEY` | *(unset)* | Alpaca secret — never returned by the API. |
| Paper trading enabled | DB only | `false` | Master toggle. When off, `PaperTradeSkill` skips but the data panel remains active. |
| Position size | DB only | `500` | Target $ per bracket order. Actual cost = `floor(size / price) × price`. |
| Min confidence | DB only | *(signal floor)* | Minimum confidence for auto-trading. Defaults to global `CONFIDENCE_FLOOR` if unset. |

`.env` values act as defaults; values saved via the Settings page are stored in
SQLite and take precedence.

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/paper/account` | Live Alpaca account summary |
| `GET` | `/paper/orders` | Local DB paper orders (most recent first) |
| `GET` | `/paper/positions` | Live open positions from Alpaca |
| `POST` | `/paper/orders/place` | **New** — manual bracket order placement |
| `POST` | `/paper/orders/{id}/cancel` | Cancel a pending order |
| `POST` | `/paper/sync` | Manual order-status poll |
| `GET` | `/paper/clock` | Alpaca market clock (is_open, next_open, next_close) |
| `GET` | `/paper/history` | Portfolio equity curve |
| `GET` | `/paper/market/snapshots` | Live price snapshots for watchlist tickers |
| `POST` | `/settings/alpaca` | Save credentials + settings |
| `POST` | `/settings/alpaca/test` | Test credentials without saving |

---

## Fractional Trading (real money)

The **🪙 Fractional Trading** tab runs a separate engine designed for a small
real-money budget (e.g. €/$100). Instead of whole-share bracket orders it places
**notional fractional buys** — "$15 of AAPL" → ~0.07 shares — because Alpaca
rejects fractional bracket orders.

### Two named profiles

Fractional trading uses a **second Alpaca profile** with its **own** API key,
secret and host, completely separate from the Order Trading account:

| | Order Trading | Fractional Trading |
|---|---|---|
| DB keys | `alpaca_key_id` / `alpaca_secret_key` / `alpaca_paper_url` | `frac_alpaca_key_id` / `frac_alpaca_secret_key` / `frac_alpaca_url` |
| Host | paper | **paper → live** (you swap it) |
| Orders | whole-share bracket | notional fractional buy + app-side exit |

**Going live is a one-field swap:** during the monitoring period point the
fractional profile at your **paper** keys + `paper-api.alpaca.markets`. When the
paper track record looks good, edit the profile — switch its host to
`api.alpaca.markets` and paste your **live** keys. Nothing else changes. (Alpaca
paper and live are different accounts with different keys — the same key cannot do
both.)

### Entry, exit and criteria

Fractional orders **cannot carry a broker-side stop/target bracket**, so exits are
enforced by the app:

```
long signal → FracTradeSkill → notional market BUY (frac profile)
                             → save frac_positions row (stop, target, mode)

every ~60s (MonitorScheduler exit poller):
    monitor_frac_positions()
        read live price for each open position
        price ≥ take_profit_price  → market SELL the held fraction   (reason: target)
        price ≤ stop_price         → market SELL the held fraction   (reason: stop)
        (optional) near market close + frac_eod_close → SELL          (reason: eod)
```

The stop/target come from the **same signal criteria** as Order Trading (the
ATR-based levels from `detect_opportunities`). A dedicated ~60 s poller (separate
from the slower scan interval) enforces them so stop-losses are honoured promptly.

- **Long-only.** Alpaca cannot short fractional shares, so short signals are skipped
  by this engine.
- **Budget cap.** New position size + total open notional must stay ≤ `frac_budget`;
  otherwise the buy is skipped.
- **Dedup.** One open fractional position per ticker.

### Placing fractional orders manually — 🪙 Frac buttons

A **🪙 Frac** action sits next to the existing paper-order button on:

- **Discovery** (Trending) — beside the 📈 Trade button on each candidate row.
- **Explorer** — Section 7 (Signals detected), beside 📈 Place (long rows only).
- **Signals** cards — beside 📈 Place Paper Order (long signals only).

Clicking it places a fractional buy on the frac profile and creates a
`frac_positions` row the poller then manages. When the profile host is **live**,
the UI asks for an explicit real-money confirmation before sending.

### Fractional tab dashboard

The **🪙 Fractional Trading** tab shows a **Paper/Live** mode badge (with a
real-money banner when live), account tiles, a **readiness readout** (closed
trades / win rate / realized P&L on paper), an **open positions** table with a
**💵 Cash out** button, and a **closed trades** table (with exit reason + realized
P&L).

### Settings — Live / Fractional Trading

| Setting | `.env` key | Default | Description |
|---|---|---|---|
| Profile name | `FRAC_PROFILE_NAME` | `offgrid-trader-frac` | Display label for the profile. |
| Account host | `FRAC_ALPACA_URL` | `https://paper-api.alpaca.markets/v2` | Paper ↔ Live selector; live = real money. |
| API Key ID | `FRAC_ALPACA_KEY_ID` | *(unset)* | Fractional profile key (set-only from the UI). |
| API Secret Key | `FRAC_ALPACA_SECRET_KEY` | *(unset)* | Fractional profile secret — never returned. |
| Fractional trading enabled | DB only | `false` | Master toggle for the **automated** `FracTradeSkill` (not the manual 🪙 buttons). |
| Per-trade size | `FRAC_POSITION_SIZE` | `15` | Notional (account currency) invested per fractional buy. |
| Total budget | `FRAC_BUDGET` | `100` | Cap on total deployed notional across open positions. |
| Min confidence | DB only | *(none)* | Optional confidence floor for the automated engine. |
| Exit poll seconds | `FRAC_POLL_SECONDS` | `60` | How often the exit poller checks prices (min 30 s). |
| End-of-day close | DB only | `false` | Sell open fractional positions near the market close. |

### Fractional API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/frac/settings` | Save the fractional profile + engine params |
| `GET` | `/frac/account` | Fractional profile Alpaca account summary |
| `GET` | `/frac/history` | Fractional profile equity curve (for the Portfolio Equity chart) |
| `GET` | `/frac/positions` | Fractional positions (open enriched with live P&L) |
| `GET` | `/frac/readiness` | Paper track record + current mode |
| `POST` | `/frac/order` | Manual fractional buy (long-only; `confirm_live` for live host) |
| `POST` | `/frac/positions/{ticker}/close` | Cash out a fractional position |
| `POST` | `/frac/connection-test` | Validate frac credentials without saving |

### Caveats

- **Currency.** Alpaca US accounts are **USD**-denominated — a "€100" budget maps
  to the account's USD balance; the budget number is in account currency. Confirm
  fractional support + currency for your Alpaca entity before funding.
- **Uptime.** Fractional positions have **no broker-side stop** — exits depend on
  the app + poller running during market hours. If the app is down, open positions
  are unmanaged until it restarts.
- **Market hours.** Fractional orders are `day`-only (Alpaca does not allow `gtc`
  for fractional), so they trade during regular US hours only.

---

## Autonomous trading

By default the scan pipeline is **hands-off**: when a signal fires it can place a
paper bracket order and/or a fractional buy automatically — no phone tap needed.
This is controlled by the **Settings → Autonomous** panel plus the master switches
on the **Order Trading** and **Live / Fractional** panels.

### The flow

```
Discovery (hourly)  ──▶  optional auto-add tradable candidates to the watchlist
        │
Scan (every N min)  ──▶  analyse watchlist  ──▶  signal ≥ confidence floor
        │
Tradability gate    ──▶  can this signal place ANY order?
        │                   • no  → drop it (a useless signal is never saved)
        │                   • yes → keep, annotated with can_bracket / can_frac
        ▼
PaperTradeSkill     ──▶  place bracket order (if can_bracket, within position cap)
FracTradeSkill      ──▶  place fractional buy (if can_frac, long-only, within budget)
        ▼
Notification        ──▶  ✅ placed  |  ⚠️ blocked (top up / cap)  |  ✗ failed
```

### The tradability gate

Before a signal is saved, the pipeline checks the Alpaca asset:

- `can_bracket` = tradable **and** (long, or short **and** shortable)
- `can_frac` = tradable **and** fractionable **and** long

A signal that can do **neither** is *useless* and is dropped so it never clutters
the feed. The behaviour is set by **Signal drop rule**:

| Mode | Meaning |
|---|---|
| `untradable` (default) | Drop only permanently-unactionable signals. Transient blocks (no funds / cap) keep the signal and send a "top up your wallet" notification. |
| `strict` | Also drop when transiently blocked — no "top up" notice. |
| `never` | Never drop; keep every signal for the audit trail. |

### Settings (all also settable via env vars)

| Setting | Env var | Default | Purpose |
|---|---|---|---|
| Paper auto-trade | `PAPER_TRADING_ENABLED` | `true` | Master switch for auto bracket orders |
| Frac auto-trade | `FRAC_TRADING_ENABLED` | `false` | Master switch for auto fractional buys |
| Signal / bracket floor | `CONFIDENCE_FLOOR` | `75` | Min confidence to create a signal / bracket |
| Fractional floor | `FRAC_MIN_CONFIDENCE` | `85` | Stricter floor for fractional buys |
| Bracket-only floor | `PAPER_TRADE_MIN_CONFIDENCE` | `0` | Optional; 0 = use the signal floor |
| Max bracket positions | `PAPER_MAX_POSITIONS` | `5` | Hold new bracket orders past this many open positions |
| Signal drop rule | `SIGNAL_DROP_MODE` | `untradable` | `untradable` \| `strict` \| `never` |
| Allow live auto-frac | `FRAC_AUTOTRADE_ALLOW_LIVE` | `false` | Safety rail — see below |
| Discovery auto-add | `DISCOVERY_AUTOADD_ENABLED` | `false` | Auto-add tradable high-score candidates to the watchlist |

The env var is the boot default; a value saved from Settings overrides it live at
call time (no restart).

### Paper-only safety rail

Autonomous fractional buys are **paper-only** by default. Even with
`FRAC_TRADING_ENABLED=true`, if the fractional profile points at a **live** Alpaca
host the auto-buy is **hard-blocked** unless you explicitly set
`FRAC_AUTOTRADE_ALLOW_LIVE=true`. Manual tap-to-buy (with its own live confirmation)
is unaffected. This prevents the loop from ever spending real money by accident.

---

## Limitations

| Item | Detail |
|---|---|
| Starting balance | Alpaca always resets paper accounts to $100 k. |
| Fractional shares | **Not supported** for bracket orders. All orders use whole shares. |
| High-price stocks | If `floor($500 / price) < 1`, the order is skipped. Increase position size in Settings to trade stocks priced above your budget. |
| Historical bars | Alpaca free tier does not provide historical OHLCV bars. Snapshots (used for the watchlist) work fine. |
| Market hours | US equities only (9:30–16:00 ET, Mon–Fri). Extended-hours orders are not placed. |
| Buying power | Alpaca paper accounts are margin accounts (4× equity). This is cosmetic — the app only ever uses a small fraction per order. |
