# MarketSage — Screenshots

Viewport-accurate screenshots of the app at 1440 × 900 px (desktop).
Captured with headless Chromium via [Playwright](https://playwright.dev).

## Files

### Overview (app tabs)

| File | Content |
|---|---|
| `01-dashboard.png` | Dashboard — watchlist with tickers, signal-count badges |
| `02-explorer.png` | Analysis Explorer — empty state |
| `03-learn.png` | Learn tab — all sections collapsed |
| `04-learn-expanded.png` | Learn — Pipeline section expanded |
| `05-settings.png` | Settings — scheduler, alerts, Ollama model selector |

### Explorer — section walkthrough (AAPL)

| File | Content |
|---|---|
| `explorer-01-pipeline.png` | Pipeline walkthrough — per-step progress with timing badges |
| `explorer-02-price.png` | Price snapshot — current price, day change, volume bar |
| `explorer-03-company.png` | Company overview — sector, market cap, P/E |
| `explorer-04-chart.png` | Historical chart — OHLCV price + volume |
| `explorer-05-indicators.png` | Technical indicators — RSI/MACD/EMA across 1H · 4H · 1D |
| `explorer-06-news.png` | Recent headlines — Finnhub news feed |
| `explorer-07-balance-sheet.png` | Financial health — balance sheet bar chart + D/E tile |
| `explorer-08-macro.png` | US macro context — Fed rate, CPI, unemployment, yield curve, CAPE |
| `explorer-09-ai-reasoning.png` | AI reasoning — full Ollama model output |
| `explorer-10-signals.png` | Signals detected — opportunity type, confidence, entry/stop/target |

---

## How to re-capture screenshots

### Prerequisites

1. **Full stack running:**
   ```bash
   make infra    # start Docker (WSL2) + Ollama + Portainer
   make up       # start MarketSage (or `make build` on first run)
   ```

2. **At least one saved analysis** in the history (needed for the Explorer
   per-section shots). Either wait for the scheduler to run, or trigger one
   manually:
   ```bash
   curl -X POST http://localhost:8010/analyze \
     -H "Content-Type: application/json" \
     -d '{"ticker": "AAPL"}'
   ```

3. **Node.js 18+** installed (standard in WSL2):
   ```bash
   node --version   # should print v18.x or later
   ```

### Install Playwright (first time only)

```bash
cd docs/screenshots
npm install              # installs playwright wrapper
npx playwright install chromium   # downloads the browser (~200 MB)
```

> Playwright and Chromium are gitignored — you need to do this once per machine.

### Run

```bash
# From the docs/screenshots/ directory:
cd docs/screenshots
node capture.mjs

# Or from the repo root:
node docs/screenshots/capture.mjs
```

All 15 screenshots are written to `docs/screenshots/` next to the script.
Existing files are overwritten — safe to re-run any time.

### What the script does

1. Launches a 1440 × 900 headless Chromium browser
2. Captures 5 overview screenshots (Dashboard, Explorer empty, Learn, Learn expanded, Settings)
3. Navigates to the Explorer, expands the Analysis History panel, opens the first saved analysis
4. Expands all collapsible Explorer sections
5. Scrolls to each section in turn and takes a viewport screenshot
6. Closes the browser and prints `✓ <filename>` for each

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: browserType.launch` | Run `npx playwright install chromium` |
| `⚠ No saved analysis rows found` | Create an analysis first: `curl -X POST http://localhost:8010/analyze -H 'Content-Type: application/json' -d '{"ticker":"AAPL"}'` |
| Frontend returns 404 | Stack is not running — `make up` |
| Screenshots are blank / very small | Check that the frontend built successfully: `make logs` |
