# How Signals & Confidence Work

This page explains exactly how MarketSage decides that a ticker is a **long** or **short**
opportunity and how the **confidence score** is computed.  Everything here maps 1-to-1 to the
code in `backend/opportunities.py` and `backend/analysis.py`.

---

## The pipeline at a glance

```
Market data snapshot
       │
       ▼
┌──────────────────┐     JSON verdict
│   LLM analysis   │ ──────────────────────────────────┐
│  (AI rule)       │  type, confidence, entry/stop/tgt │
└──────────────────┘                                   │
                                                       │
┌──────────────────┐                                   ▼
│  RSI extreme     │──────────────────────┐   ┌──────────────┐
│  Volume spike    │──── rule candidates ─┼──▶│    Merge &   │
│  MACD crossover  │                      │   │ corroboration│
│  Valuation P/E   │──────────────────────┘   └──────┬───────┘
└──────────────────┘                                  │
                                                      │
                                             ┌────────▼────────┐
                                             │  Macro regime   │
                                             │  filter ±pts    │
                                             └────────┬────────┘
                                                      │
                                             Confidence floor
                                             (default 65) filter
                                                      │
                                             Stored signals / alerts
```

---

## Step 1 — AI analysis

The LLM receives a structured market snapshot and must respond with exactly this JSON:

```json
{
  "trend": "bullish | bearish | neutral",
  "momentum": "strong | weak | building | fading | neutral",
  "key_levels": { "support": [210.0], "resistance": [225.0] },
  "signals": ["RSI oversold on 4H and 1D", "volume expanding on breakout"],
  "opportunity": {
    "type": "long | short | none",
    "confidence": 0–100,
    "entry": 213.50,
    "stop":  208.00,
    "target": 224.00
  },
  "risk_factors": ["earnings next week", "sector rotation risk"]
}
```

- **`type`** — the model's directional call.  `none` = no clear setup.
- **`confidence`** — the model's own self-assessed certainty (0–100).  It must beat the
  `CONFIDENCE_FLOOR` (default 65) to pass through.
- **`entry / stop / target`** — optional price levels for the trade.  Rule-based signals
  (below) inherit these from the AI if both fire on the same ticker + direction.

The prompt instructs the model: *"Base every conclusion strictly on the supplied data.
If the setup is unclear, use type 'none' and a low confidence."*

---

## Step 2 — Five deterministic rule checks

These run in parallel with the AI on the same market-data snapshot.  No model involved.

### Rule 1 — RSI extreme

RSI is read on three timeframes: **1H, 4H, 1D**.

| Condition | Direction | Starting confidence |
|---|---|---|
| RSI ≤ 30 on **2+ timeframes** | Long | `55 + 10 × count` (max 85) |
| RSI ≥ 70 on **2+ timeframes** | Short | `55 + 10 × count` (max 85) |

Examples:
- Oversold on 1H + 4H → **75** confidence long
- Oversold on 1H + 4H + 1D → **85** confidence long

One timeframe alone is not enough — the rule requires agreement across multiple horizons.

### Rule 2 — Volume spike

Fires only when **both** conditions are true simultaneously:

| Condition | Threshold |
|---|---|
| Volume vs 20-day average | ≥ 2× (configurable: `VOLUME_SPIKE_MULTIPLIER`) |
| Day price change | ≥ 2% absolute (configurable: `SIGNIFICANT_MOVE_PCT`) |

Direction follows the move: price up = **long**, price down = **short**.

Confidence: `55 + min(ratio, 5) × 3` (max 80).

A 3× volume day with a 3% move → `55 + 9 = 64` confidence.
A 5× volume day with a 5% move → `55 + 15 = 70` confidence.

### Rule 3 — MACD crossover

MACD histogram (= MACD line − signal line) is checked on **1D and 4H only**.

| Condition | Direction | Confidence |
|---|---|---|
| Histogram **positive** on both 1D and 4H | Long | 62 (fixed) |
| Histogram **negative** on both 1D and 4H | Short | 62 (fixed) |

Both timeframes must agree.  This is deliberately conservative (62) so it primarily
contributes as a corroborating source rather than a standalone trigger.

### Rule 4 — Valuation extreme (P/E)

Based on the TTM (trailing twelve months) P/E ratio from fundamentals.

| Condition | Direction | Confidence |
|---|---|---|
| P/E > 60 (severely overvalued) | Short | 40 |
| P/E < 8 (deeply discounted, must be positive) | Long | 42 |
| Negative P/E (loss-making) | — | skipped |

Confidence is **intentionally low (40–42)** so this rule never fires a signal alone —
it only reinforces an existing signal from another source after merging.

### Rule 5 — Macro regime filter *(applied after merge)*

See [Step 4](#step-4--macro-regime-filter) below.

---

## Step 3 — Merge and corroboration bonus

All candidates that agree on **same ticker + same direction** are merged into one signal.

```
final_confidence = max(individual_confidences) + 5 × (number_of_sources − 1)
```

Capped at 100.  The merged signal also collects all reasons from contributing rules.

### Worked example — AAPL long

| Source | Confidence |
|---|---|
| AI model | 72 |
| RSI oversold on 4H + 1D | 75 |
| MACD bullish on 1D + 4H | 62 |

Merge:
- Base = **75** (strongest)
- 3 sources → bonus = 5 × 2 = **+10**
- Merged confidence = **85**

Reasons stored: *"AI model flagged a long setup (confidence 72); RSI oversold on 4H, 1D; MACD bullish (above signal) on 1D and 4H"*

Entry / stop / target: inherited from the AI candidate (the only source that provides them).

---

## Step 4 — Macro regime filter

After merging, confidence is adjusted ± based on macroeconomic conditions derived from
FRED data (yield curve, Shiller CAPE, CPI YoY).  Adjustments are additive and clamped to [0, 100].

| Macro condition | Long adjustment | Short adjustment | Reason appended |
|---|---|---|---|
| Yield curve inverted | **−8** | +3 | *"⚠ yield curve inverted — macro headwind for longs"* |
| Shiller CAPE > 35 | **−5** | +3 | *"⚠ Shiller CAPE 38× — market elevated"* |
| Shiller CAPE < 15 | **+5** | −3 | *"✓ CAPE 13× — market historically cheap"* |
| CPI YoY > 5% | **−5** | none | *"⚠ CPI 6.2% YoY — Fed likely restrictive"* |

These adjustments reflect well-documented historical relationships:
- Inverted yield curves have preceded recessions — bad for long equity bets
- Extreme CAPE readings indicate stretched valuations
- High CPI keeps the Fed hawkish, compressing multiples

### Continuing the example

After merge, AAPL long has **85** confidence.  Assume current macro:
- Yield curve: normal (no penalty)
- CAPE: 37 → **−5** long
- CPI: 3.2% → no penalty

Adjusted confidence: **85 − 5 = 80**. Still above the floor → signal stored.

Now assume a stressed macro environment (2022-style):
- Yield curve inverted → **−8**
- CAPE: 32 (no penalty in this range)
- CPI: 8.1% → **−5**

Adjusted: **85 − 8 − 5 = 72**. Still above 65 → stored, but with two warning reasons attached.

If the AI had started at 68 and no rule corroborated (base 68, 1 source, no bonus):
- 68 − 8 − 5 = **55** → **below floor → dropped**

---

## Step 5 — Confidence floor filter

The final filter.  Any signal with `confidence < CONFIDENCE_FLOOR` is discarded —
never stored, never alerted.

Default floor: **65** (configurable in `.env` via `CONFIDENCE_FLOOR` or the Settings page).

This is why the valuation rule (40–42) can never create a signal on its own — it must
stack with at least two other sources to clear the floor.

---

## What "long" and "short" mean

| Signal | Interpretation |
|---|---|
| **Long** | The system expects the price to rise. Equivalent to a **buy** signal. |
| **Short** | The system expects the price to fall. Equivalent to a **sell / short-sell** signal. |

> ⚠️ **Not financial advice.** These signals are generated from technical and macro
> indicators using automated rules and an LLM.  They are for educational and research
> purposes only.  Always apply your own judgement and risk management before trading.

---

## Confidence score reference

| Range | Interpretation |
|---|---|
| < 65 | Below floor — never stored |
| 65–74 | Weak signal — typically a single rule with mild corroboration |
| 75–84 | Moderate signal — multiple agreeing sources or strong single rule |
| 85–94 | Strong signal — AI + 2+ rules + favourable macro |
| 95–100 | Very strong — near-perfect alignment across all sources |

---

## Configurable thresholds

All thresholds can be adjusted in `.env` (restart required) or viewed in `GET /health`:

| Variable | Default | Effect |
|---|---|---|
| `CONFIDENCE_FLOOR` | `65` | Signals below this are discarded |
| `RSI_OVERSOLD` | `30` | RSI ≤ this triggers the long rule |
| `RSI_OVERBOUGHT` | `70` | RSI ≥ this triggers the short rule |
| `VOLUME_SPIKE_MULTIPLIER` | `2.0` | Volume must be this × avg to qualify |
| `SIGNIFICANT_MOVE_PCT` | `2.0` | Day move must exceed this % for volume rule |

---

## Related pages

- [Indicators](indicators.md) — detailed definition of each indicator (RSI, MACD, EMA, Bollinger, Stochastic, etc.)
- [Architecture](architecture.md) — how the pipeline fits together end-to-end
- [Glossary](glossary.md) — trading term definitions
- [API Reference](api.md) — `GET /signals` and `GET /analysis/{ticker}` response schemas
