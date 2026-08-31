# Signal Scan — User Prompt Structure

The user prompt for live signal analysis is built dynamically by
`backend/analysis.py → build_prompt()`. The LLM receives a compact text
representation of market data followed by pre-computed candidate trade plans.

## Layout (in order)

```
[Optional PRIOR CONTEXT section from MemoryLayer]

Ticker: AAPL
Name: Apple Inc.
Sector: Technology / Consumer Electronics
As of: 2026-08-18T13:05:00

PRICE / VOLUME
  Current: $227.82  (day change: +1.3%)
  ...

TECHNICALS
  1H  RSI=58.2  MACD=0.42/signal=0.31  ...
  4H  ...
  1D  ...

[BALANCE SHEET — when data available]
[MACRO CONTEXT — always included]
[VALUATION — when P/E available]
[RECENT NEWS HEADLINES — when FINNHUB_API_KEY set]

CANDIDATE TRADE PLANS (backend-generated; select one plan_id or null)
[{"plan_id":"long_atr","side":"long","entry":227.82,"stop":223.20,"target":236.86,"reward_risk":2.0},
 {"plan_id":"short_atr","side":"short","entry":227.82,"stop":232.44,"target":218.78,"reward_risk":2.0}]

Return one JSON object using the REQUIRED OUTPUT SCHEMA in the system prompt.
Use request_id="AAPL-2026-08-18T13:05:00", ticker="AAPL", as_of="2026-08-18T13:05:00".
Select a plan_id from CANDIDATE TRADE PLANS or null.
```

## Candidate plan generation

Plans are pre-computed from:
- `entry` = current price
- ATR estimate = (1D BB_upper − BB_lower) / 4, or price × 2% if bands unavailable
- `stop`/`target` from ATR × atr_multiple and reward_risk settings

The LLM selects one plan_id (or null for no signal) — it never calculates price levels.
News headlines in the prompt may influence which plan the LLM selects.
