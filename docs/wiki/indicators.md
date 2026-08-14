# Technical Indicators Reference

This page explains every indicator the system fetches and how it uses each one.
The same content is available in-app on the **Learn** tab.

---

## How indicators are computed

OHLCV history is downloaded from **yfinance** and processed locally by the
open-source **`ta`** library (no API key, no rate limits, MIT licence).

| Timeframe | Download | Bars available | Use |
|---|---|---|---|
| 1H | `period="1y", interval="1h"` | ~1 638 bars | Short-term momentum, noise-sensitive |
| 4H | Resampled from the 1H download | ~410 bars | Medium-term trend confirmation |
| 1D | `period="2y", interval="1d"` | ~504 bars | Long-term context, most reliable for swing signals |

All three timeframes cover enough history for EMA200 (needs 200 bars). Agreement
across multiple timeframes is a much stronger signal than a single reading.

---

## RSI — Relative Strength Index

**Scale:** 0 → 100

Measures the speed and magnitude of recent price changes. Calculated as the ratio of
average gains to average losses over the last 14 periods.

| Value | Interpretation |
|---|---|
| **< 30** | **Oversold** — price fell fast; selling may be exhausted; potential bounce |
| 30–70 | Neutral — no extreme reading |
| **> 70** | **Overbought** — price rose fast; buying may be exhausted; potential pullback |

> **What the system checks:** RSI extreme (< 30 or > 70) on **2 or more** of the three
> timeframes simultaneously. Single-timeframe extremes are ignored — they are too
> common to be meaningful on their own.

---

## MACD — Moving Average Convergence/Divergence

**Three components:** MACD line · Signal line · Histogram

- **MACD line** = 12-period EMA − 26-period EMA
- **Signal line** = 9-period EMA of the MACD line
- **Histogram** = MACD − Signal (this is what the chart plots)

| Histogram | Interpretation |
|---|---|
| **Positive and rising** | Upward momentum building |
| **Positive and falling** | Upward momentum weakening |
| **Negative and falling** | Downward momentum building |
| **Crossing zero upward** | Bullish momentum shift |
| **Crossing zero downward** | Bearish momentum shift |

> **What the system checks:** MACD line above its signal line on **both** 1D and 4H
> (bullish crossover). MACD below signal on both (bearish). Requiring both timeframes
> filters out short-term whipsaws.

---

## EMA — Exponential Moving Average

**Three periods:** EMA 20 · EMA 50 · EMA 200

A weighted moving average that gives more weight to recent prices, so it reacts faster
than a simple moving average (SMA).

| Relationship | Interpretation |
|---|---|
| Price > EMA | Bullish — price trading above its average |
| Price < EMA | Bearish — price trading below its average |
| EMA 50 > EMA 200 | **Golden Cross** — long-term bullish signal; widely watched by institutions |
| EMA 50 < EMA 200 | **Death Cross** — long-term bearish signal |
| EMA 20 > EMA 50 | Short-term uptrend within the medium-term trend |

> **What the system uses:** EMA values are included in the AI prompt. The Explorer
> charts show `(price − EMA) / EMA × 100` — positive = price above EMA (green),
> negative = price below (red).

---

## Bollinger Bands

**Three bands:** Upper · Middle (MA 20) · Lower

The middle band is a 20-period simple moving average. Upper and lower bands are
±2 standard deviations from the middle. They widen in volatile markets and contract
in quiet ones.

| Condition | Interpretation |
|---|---|
| Price touching upper band | Potentially overbought; may pull back to middle |
| Price touching lower band | Potentially oversold; may bounce to middle |
| **Band squeeze** (bands narrow) | Volatility compression; breakout often follows |
| Band expansion after squeeze | Confirms a new trending move has begun |

> **What the system uses:** BB values are included in the AI prompt and visible in
> the collapsible indicator table. Not used in the current rule-based detection logic.

---

## Stochastic K% / D%

**Scale:** 0 → 100

Compares the current closing price to the high-low range over the last 14 periods.

- **%K** = (Close − Lowest Low) / (Highest High − Lowest Low) × 100
- **%D** = 3-period SMA of %K (smoothing)

| Value | Interpretation |
|---|---|
| **< 20** | Oversold (similar to RSI < 30) |
| **> 80** | Overbought (similar to RSI > 70) |
| %K crossing above %D | Bullish signal |
| %K crossing below %D | Bearish signal |

> **What the system uses:** Stochastic values are included in the AI prompt and
> visible in the indicator table. Not used in the current rule-based detection.

---

## Volume Ratio

**Formula:** current session volume ÷ 20-day average volume

Raw volume numbers vary enormously between stocks (AAPL trades billions of shares;
small-caps trade thousands). The ratio normalises volume so any stock can be compared
on the same scale.

| Ratio | Interpretation |
|---|---|
| **> 2×** | Very unusual — major news, earnings, or institutional order flow |
| **1.5–2×** | Elevated — worth noting |
| **≈ 1×** | Normal trading session |
| **< 0.5×** | Thin volume — any price move is low-conviction |

> **What the system checks:** Volume ≥ `VOLUME_SPIKE_MULTIPLIER` × average (default: 2.0×)
> **AND** day price move ≥ `SIGNIFICANT_MOVE_PCT` (default: 2%). Both thresholds are
> configurable in `.env`.

---

## Recommendation signal

Each timeframe carries a locally-computed `recommendation` string derived from a
4-signal symmetric vote:

| Signal | Bullish (+1) | Bearish (−1) |
|---|---|---|
| RSI | > 60 | < 40 |
| MACD histogram | positive | negative |
| Close vs EMA 20 | close > EMA20 | close < EMA20 |
| Close vs EMA 50 | close > EMA50 | close < EMA50 |

Score ≥ 2 → `BUY` · Score ≤ −2 → `SELL` · Otherwise → `NEUTRAL`

This is passed to the AI as additional context but not used directly in rule-based detection.

---

## Further reading

- [RSI — Investopedia](https://www.investopedia.com/terms/r/rsi.asp)
- [MACD — Investopedia](https://www.investopedia.com/terms/m/macd.asp)
- [EMA — Investopedia](https://www.investopedia.com/terms/e/ema.asp)
- [Bollinger Bands — Investopedia](https://www.investopedia.com/terms/b/bollingerbands.asp)
- [Stochastic Oscillator — Investopedia](https://www.investopedia.com/terms/s/stochasticoscillator.asp)
