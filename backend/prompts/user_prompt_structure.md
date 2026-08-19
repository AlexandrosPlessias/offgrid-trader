# User Prompt Structure

The user prompt is built dynamically by `backend/analysis.py → build_prompt()`.
Below is the section layout with example values. Actual values come from
`get_market_data(ticker)` at scan time.

---

## Optional: PRIOR CONTEXT (injected when MemoryLayer has a recent record)

```
PRIOR CONTEXT (from last scan 4h ago):
  Last signal: LONG, confidence 72
  RSI oversold streak: 2 consecutive scans
  Price since last scan: -1.4%
```

## Header

```
Ticker: AAPL
Name: Apple Inc.
Sector: Technology / Consumer Electronics
As of: 2026-08-18T13:05:00
```

## PRICE / VOLUME

```
PRICE / VOLUME
  Price:          $227.82  (day change: +1.3%)
  Volume ratio:   1.42×    (vs 20-day avg)
  52-week range:  $164.08 – $237.49
  MA5:            $224.10   MA20: $219.85
```

## TECHNICALS (one block per timeframe: 1H, 4H, 1D)

```
TECHNICALS
  1H  RSI=58.2  MACD=0.42/signal=0.31  EMA20=$225.1 EMA50=$222.8 EMA200=$210.3
      BB upper=$228.9 mid=$225.1 lower=$221.3  Stoch K=67 D=61  rec=BUY
  4H  RSI=62.1  ...
  1D  RSI=55.8  ...
```

## DATA WARNINGS (optional — when indicators are unavailable)

```
DATA WARNINGS
  1H indicators unavailable
```

## BALANCE SHEET

```
BALANCE SHEET (annual, USD)
  Total assets:       $364.98B
  Total liabilities:  $302.08B
  Stockholders eq.:   $62.15B
  Total debt:         $104.59B
  Cash & equiv.:      $65.17B
  Debt-to-equity:     168.4%
```

## MACRO CONTEXT

```
MACRO CONTEXT
  Fed funds rate:     5.33%
  CPI YoY:            3.2%
  Unemployment:       3.9%
  10y-2y yield curve: -0.41%  ← INVERTED — recession signal
  Shiller CAPE:       34.8
```

## VALUATION

```
VALUATION
  TTM P/E:     28.1
  Forward P/E: 24.7
  Market cap:  $3.49T (mega-cap)
```

## RECENT NEWS HEADLINES (optional — requires FINNHUB_API_KEY)

```
RECENT NEWS HEADLINES (last 7 days)
  [Reuters] Apple beats Q3 earnings estimates on services growth (2026-08-15)
  [Bloomberg] Fed signals rate hold amid cooling inflation (2026-08-14)
```

---

The complete prompt is passed as the `user` message to Ollama's `/api/chat`
endpoint alongside the system prompt from `prompts/system_prompt.md`.
