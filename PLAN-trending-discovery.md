# Plan: Trending Ticker Discovery (Backlog Item 5)

Add automatic candidate discovery so the system surfaces promising tickers instead of only scanning a static watchlist. Candidates come from Alpaca's screener (with a key-free yfinance fallback), get scored by a deterministic momentum/trend score reusing the existing indicator stack, then surface in a new **Trending** tab with one-click watchlist add and optional auto-scan of the top-N.

Branch: `feat/backlog-5-trending-discovery` (off `main`)

## Decisions

- **Source**: yfinance predefined screeners + Alpaca screener
- **UI**: new top-level "Trending" tab
- **Auto-scan of top-N**: included in this PR
- **Watchlist expansion** (bulk-import + grouping): included in this PR
- Deterministic scoring only — no LLM ranking, avoiding quota consumption
- Discovery never auto-adds tickers; that stays curation

## Verified facts

- `.venv` yfinance exposes `yf.screen()` + `PREDEFINED_SCREENER_QUERIES` with keys including `day_gainers`, `day_losers`, `most_actives`, `small_cap_gainers`
- Alpaca screener endpoints (`data.alpaca.markets`):
  - `GET /v1beta1/screener/stocks/most-actives?by=volume|trades&top=1..100`
    → `{"most_actives":[{symbol,volume,trade_count}],"last_updated"}`
  - `GET /v1beta1/screener/{stocks|crypto}/movers?top=1..50`
    → `{"gainers":[{symbol,price,change,percent_change}],"losers":[...],...}`
  - Free-tier availability is **not** explicitly documented → verify at runtime, fall back to yfinance
- `backend/alpaca.py`: raw httpx, `_DATA_URL = https://data.alpaca.markets`, `_TIMEOUT=15`, `_get/_post/_delete`, `AlpacaError`, `_validate_url()` SSRF guard, existing `get_snapshots()` → `/v2/stocks/snapshots`. Credentials: DB via `get_setting` → env `AlpacaConfig`. `get_client()` singleton.
- `backend/data.py`: `compute_indicators(ticker)` returns `{"technicals":{"1H","4H","1D"}}`, cached per day as `indicators:{TICKER}:{YYYY-MM-DD}`; `_cache_get/_cache_set` support `ttl_minutes`. `fetch_yfinance()` → price/fundamentals, cache `price:{TICKER}:{date}`.
- `backend/database.py`: `_SCHEMA` (CREATE TABLE IF NOT EXISTS), `init_db()` uses `PRAGMA table_info` + `ALTER TABLE` for migrations. `get_setting/set_setting`. `get_effective_watchlist()` = base env + `watchlist_added` − `watchlist_removed` (JSON in `app_settings`).
- `backend/main.py`: watchlist endpoints — GET, POST (`AddTickerRequest`), DELETE.
- `backend/scheduler.py`: `MonitorScheduler`, `_loop()` (is_market_open → scan_watchlist → sync_paper_orders → re-read interval each cycle), `scan_ticker_async`, `scan_watchlist`.
- `backend/orchestrator.py`: concurrency caps `concurrent_tickers` (3), `concurrent_llm` (2).
- Rate-limiting precedent: `_RpmThrottle` in `backend/backtest.py`.
- `frontend/src/App.jsx`: nav tabs (dashboard/explorer/paper/education), view containers using `display: activeView === '…' ? '' : 'none'`, `setActiveView`.
- recharts `^2.12.0` available; no new frontend dependencies needed.
- No existing screener/movers/discovery code anywhere (confirmed).

## Branch

Branch `feat/backlog-5-trending-discovery` already exists (off `main`, commit `874905f`).
Verify with `git status` before writing any code — do not create a new branch.

## Phases

### Phase 1 — Discovery data sources

- `backend/alpaca.py`: add `get_most_actives(top)` and `get_movers(top)` using `_DATA_URL` + `/v1beta1/screener/...`; reuse `_get()` + `AlpacaError`; keep `_validate_url` host allowlist.
- `backend/discovery.py` (NEW): `fetch_candidates(sources, limit) -> list[dict]`
  - Alpaca first when credentials present; on `AlpacaError`/403 fall back to yfinance
  - yfinance via `yf.screen('day_gainers'|'most_actives'|'day_losers')`
  - Normalize to `{symbol, price, percent_change, volume, source}`
  - Cache raw candidate list as `discovery:candidates:{YYYY-MM-DD-HH}` with ~60m TTL via `data.py` `_cache_get/_cache_set`

### Phase 2 — Scoring (depends on 1)

- `backend/discovery.py`: `score_candidate(ticker, snapshot) -> dict`
  - Reuse `compute_indicators(ticker)` (per-day cached → cheap on repeat)
  - Composite 0–100: momentum (% change), volume ratio, trend alignment (price > EMA20 > EMA50 rising), multi-timeframe RSI/MACD agreement
  - Return `{score, reasons[], components{}}` — mirroring the `score_breakdown` style in `opportunities.py`
- Cull **before** scoring to `discovery_max_candidates` (default 25) to bound yfinance calls
- Throttle indicator fetches (reuse the `_RpmThrottle` pattern from `backtest.py`)

### Phase 3 — Persistence + config (parallel with 2; `DiscoveryConfig` must land before `score_candidate()` is called at runtime)

- `backend/database.py` `_SCHEMA`: add
  - `discovery_runs(id, created_at, sources, candidate_count, status, error)`
  - `discovery_candidates(id, run_id FK, ticker, score, price, percent_change, volume, source, reasons JSON, components JSON, created_at)`
  - `watchlist_groups(id, name UNIQUE, tickers JSON, created_at)`
  - Helpers: `save_discovery_run`, `update_discovery_run`, `save_discovery_candidates`, `get_latest_discovery`, `get_watchlist_groups`, `save_watchlist_group`, `delete_watchlist_group`
- `backend/config.py`: `DiscoveryConfig` dataclass + `_env_*` helpers; DB keys override at call time:
  `discovery_enabled` (false), `discovery_sources` ("alpaca,yfinance"), `discovery_max_candidates` (25), `discovery_min_score` (60), `discovery_interval_minutes` (60), `discovery_autoscan_enabled` (false), `discovery_autoscan_top_n` (3)

### Phase 4 — API (depends on 1–3)

- `backend/main.py`:
  - `GET /discovery/trending` — latest run + ranked candidates (+ `already_in_watchlist` flag)
  - `POST /discovery/refresh` — SSE stream mirroring the `/analyze/stream` frame shape (`{type:"step"|"result"|"error"}`); run in threadpool
  - `GET|POST /settings/discovery` — `DiscoverySettingRequest` (Pydantic, validated ranges)
  - `POST /watchlist/bulk` — `{tickers:[...]}` add many (reuse add logic, dedupe, cap size)
  - `GET|POST|DELETE /watchlist/groups` — sector/theme grouping

### Phase 5 — Scheduler auto-scan (depends on 4)

- `backend/scheduler.py` `_loop()`: after `scan_watchlist` + `sync_paper_orders`, add a guarded discovery cycle — only when market open, `discovery_enabled`, and `discovery_interval_minutes` elapsed (track `last_discovery` on `MonitorScheduler`)
- If `discovery_autoscan_enabled`: take top-N by score above `discovery_min_score`, run through existing `scan_ticker_async` respecting the `concurrent_tickers` cap. Never auto-add to the watchlist.
- Extend `status()` with `last_discovery` / `next_discovery`

### Phase 6 — Frontend (depends on 4)

- `frontend/src/App.jsx`:
  - Add `Trending` nav tab + view container following the existing pattern
  - Trending view: refresh button (SSE progress), ranked candidate table (ticker, price, %chg, volume, score, reasons, source pill), one-click "Add to watchlist", score bar chart via recharts, inline settings row (enable, sources, max candidates, min score, interval, auto-scan + top-N)
  - **Settings panel** (settings view): add a "Discovery" section card with the same fields (`discovery_enabled`, `discovery_sources`, `discovery_max_candidates`, `discovery_min_score`, `discovery_interval_minutes`, `discovery_autoscan_enabled`, `discovery_autoscan_top_n`). Reads via `GET /settings/discovery`; saves via `POST /settings/discovery`. Consistent with the existing Alerts / Scheduler / LLM / Alpaca section cards. No additional API changes needed.
  - Watchlist UI: bulk-import textarea (comma/newline) → `POST /watchlist/bulk`; group create/assign/delete

### Phase 7 — Tests + docs (depends on all)

- `tests/smoke/smoke_test.py`: new numbered section — mock `yf.screen` + Alpaca `_get`; assert normalization, cull, scoring bounds 0–100, dedupe, empty/network-failure graceful handling, min-score filter, auto-scan top-N selection
- `docs/wiki`: new `trending-discovery.md` + `_Sidebar.md` entry; update `api.md`, `settings.md`, `architecture.md`
- `README.md`: add "Trending Ticker Discovery" bullet to the Features section; update quick-start if needed
- `BACKLOG.md`: mark item 5 complete on finish

## Files

- **NEW** `backend/discovery.py` — candidate fetch + scoring
- `backend/alpaca.py` — screener calls
- `backend/database.py` — 3 tables + helpers
- `backend/config.py` — `DiscoveryConfig`
- `backend/main.py` — endpoints
- `backend/scheduler.py` — discovery cycle + auto-scan
- `frontend/src/App.jsx` — Trending tab + watchlist bulk/groups
- `tests/smoke/smoke_test.py`, `docs/wiki/*`, `BACKLOG.md`

## Verification

1. `make lint` (ruff + flake8 + black + pytest via `.venv`)
2. `python tests/smoke/smoke_test.py` — new section passes
3. Runtime probe: confirm the Alpaca screener works on the free tier; otherwise exercise the yfinance fallback path
4. `curl POST /discovery/refresh` then `GET /discovery/trending` — ranked list returned
5. Toggle auto-scan; confirm scheduler logs discovery + top-N scans and does not mutate the watchlist
6. UI: Trending tab renders, add-to-watchlist works, bulk import + groups persist
7. Quota check: repeat refresh within cache TTL issues no new yfinance calls

## Scope

**In scope**: discovery sources, scoring, persistence, API, scheduler auto-scan, Trending tab, watchlist bulk-import + grouping, tests, docs.

**Out of scope**: crypto discovery, paid data tiers, options flow, auto-adding tickers to the watchlist, LLM-based ranking.

## Further consideration

~~1. If Alpaca's screener turns out to be paid-tier only, should the Alpaca code path stay behind a capability check, or be dropped in favour of yfinance-only?~~
**Resolved**: Alpaca screener methods are written but guarded by a runtime 403/`AlpacaError` catch; the yfinance fallback is always exercised in tests; no separate feature flag needed.
