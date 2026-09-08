# Trending Ticker Discovery

MarketSage can automatically surface promising tickers you are not yet watching
by querying market screeners and scoring candidates with a deterministic
momentum + trend model — no LLM quota is consumed for discovery.

---

## How it works

```
Alpaca screener  ──┐
                   ├─► fetch_candidates() ─► dedupe ─► cull to max_candidates
yfinance screen ───┘                                         │
                                                             ▼
                                                     score_candidate() × N
                                                             │
                                                 ┌───────────┴──────────────┐
                                                 │  filter min_score, sort  │
                                                 └──────────────────────────┘
                                                             │
                                                  persist to discovery_runs /
                                                  discovery_candidates tables
```

### Data sources

| Source | Endpoint | Notes |
|---|---|---|
| **Alpaca screener** (primary) | `GET /v1beta1/screener/stocks/most-actives` and `/movers` | Requires Alpaca credentials; guarded by runtime 403 catch |
| **yfinance** (fallback + optional) | `yf.screen("day_gainers")` etc. | Used when Alpaca is unavailable or not configured |

If Alpaca returns an error (including HTTP 403 on the free tier), the system
falls back to yfinance transparently.

### Scoring (0-100, deterministic)

| Component | Max | Logic |
|---|---|---|
| **Momentum** | 30 | `\|percent_change\|` linearly mapped to 10 %; capped |
| **Volume** | 25 | Snapshot volume linearly mapped up to 25 M shares |
| **Trend** | 25 | Price > EMA20 (+10), EMA20 > EMA50 (+10), 1D rec = buy (+5) |
| **RSI/MACD** | 20 | RSI 40-70 and MACD > signal across 1H/4H/1D (+0.5 per TF signal) |

Scores use the same `compute_indicators()` call as the live scanner (per-day
cached), so scoring 25 candidates typically costs ≤25 cache hits, not 25
network round-trips.

---

## Configuration

Settings are available in two places:

- **Settings → 🔥 Trending Discovery** — full settings panel
- **Trending tab → ⚙ Settings** link — shortcut to the same panel

| Setting | Default | Description |
|---|---|---|
| `discovery_enabled` | false | Run discovery on a schedule |
| `discovery_sources` | `alpaca,yfinance` | Comma-separated source list |
| `discovery_max_candidates` | 25 | Candidates scored per run |
| `discovery_min_score` | 60 | Candidates below this score are hidden |
| `discovery_interval_minutes` | 60 | Minutes between scheduled runs |
| `discovery_autoscan_enabled` | false | Run full agent pipeline on top-N candidates |
| `discovery_autoscan_top_n` | 3 | Number of candidates to auto-scan |

All settings override env-var defaults and take effect without a restart.

---

## API

### `GET /discovery/trending`

Return the most-recent completed run with ranked candidates.

Query params: `limit` (1–100, default 25)

```json
{
  "run": { "id": 1, "created_at": "...", "sources": "alpaca,yfinance", "candidate_count": 12, "status": "done" },
  "candidates": [
    {
      "ticker": "NVDA", "price": 131.2, "percent_change": 4.5, "volume": 45000000,
      "source": "alpaca_actives", "score": 87.5,
      "reasons": ["Strong move +4.5% today (up)", "Price above EMA20 (uptrend)"],
      "components": { "momentum": 13.5, "volume": 25.0, "trend": 25.0, "rsi_macd": 14.0 },
      "already_in_watchlist": false
    }
  ],
  "watchlist": ["AAPL", "MSFT"]
}
```

### `POST /discovery/refresh`

Run a new discovery cycle. Always bypasses the 60-min candidate cache. Returns a Server-Sent Events stream:

```
data: {"type":"step","step":"fetch","message":"Alpaca: 100 raw candidates fetched (scoring pool — top 50 will be scored)"}
data: {"type":"step","step":"warn","message":"⚠ Alpaca screener unavailable (403) — falling back to yfinance"}
data: {"type":"step","step":"fetch","message":"yfinance: 38 candidates fetched"}
data: {"type":"step","step":"score","message":"[1/25] Computing NVDA…"}
data: {"type":"step","step":"score","message":"[1/25] NVDA → 87 pts  (Strong move +4.5% today)"}
data: {"type":"result","run_id":2,"candidate_count":10,"candidates":[...]}
```

`warn` steps are emitted for non-fatal issues (Alpaca 403, key not configured). They do not abort the run.

### `GET /discovery/history`

Query params: `limit` (1–100, default 20). Returns run summaries without candidates.

### `GET /discovery/history/{run_id}/candidates`

Returns all scored candidates for a specific run, ordered by score descending. Useful for inspecting past runs in the UI history drill-down.

### `GET /settings/discovery` / `POST /settings/discovery`

Read or update discovery configuration. All fields optional on POST.

### `POST /watchlist/bulk`

Add multiple tickers at once: `{"tickers": ["NVDA", "AMD", "TSLA"]}`.

### `GET /watchlist/groups` / `POST /watchlist/groups` / `DELETE /watchlist/groups/{id}`

Manage named watchlist groups (e.g. "Semiconductors", "AI").

---

## UI features

### Discovery tab (nav: Dashboard → Trading → **Discovery** → Explorer → Learn)

| Feature | Description |
|---|---|
| **Run summary card** | Shows timestamp, candidate count, source breakdown (`N from Alpaca · M from yfinance`), top score, avg score, and top-5 ticker chips |
| **Live step log** | Real-time SSE progress — fetch counts, per-ticker `[N/total] TICKER → score` scoring, `⚠️` amber warnings |
| **Candidate table** | Ticker, Price, Change, Volume, Score (bar), Reasons, Source badge, + Watch |
| **Score breakdown** | Click the Score cell to expand per-component bars (Momentum / Volume / Trend / RSI/MACD) with earned/max, progress bar, and the matching reason as a caption |
| **Run history** | Collapsible section at page bottom; click any ✅ row to expand candidates with 🔵 Alpaca / 🟡 yfinance source badges, + Watch, and ticker → Explorer deep-link |
| **Settings deep-link** | ⚙ Settings button navigates to Settings and scrolls to the Discovery section |

### Price enrichment

Alpaca `most_actives` returns only symbol + volume. After fetching, a single batch `yf.download` call fills in `price` and `percent_change` for all rows missing them before scoring and caching.

---

## Database tables

| Table | Purpose |
|---|---|
| `discovery_runs` | One row per run (sources, status, candidate count, error) |
| `discovery_candidates` | One row per scored ticker per run (score, components, reasons) |
| `watchlist_groups` | User-defined named ticker buckets |

Discovery data is never deleted by the "Clear all data" action in Settings.

---

## Scheduler integration

When `discovery_enabled=true` and the scheduler is running, a discovery cycle
fires automatically after each watchlist scan, subject to the
`discovery_interval_minutes` cooldown.  If `discovery_autoscan_enabled=true`,
the top-N candidates are also run through the full agent pipeline
(`scan_ticker_async`) and results are stored as regular signals — but tickers
are **never auto-added to the watchlist** (curation stays manual).
