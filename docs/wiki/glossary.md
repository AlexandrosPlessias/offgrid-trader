# Trading Glossary

Quick reference for terms used in **MarketSage** and in technical analysis generally.
The same content is available in-app on the **Learn** tab.

> ⚠️ **Not financial advice.** This glossary is for educational purposes only.

---

| Term | Plain English |
|---|---|
| **Balance sheet** | A snapshot of what a company owns (assets), what it owes (liabilities), and what remains for shareholders (equity). Filed quarterly; the system uses the most recent annual filing. |
| **Bearish** | Expecting price to fall. A bearish signal suggests a potential short opportunity. |
| **Bollinger Bands** | A volatility envelope around a 20-period moving average (±2 standard deviations). Bands widen in volatile markets and contract in quiet ones. See [indicators.md](indicators.md#bollinger-bands). |
| **Bullish** | Expecting price to rise. A bullish signal suggests a potential long opportunity. |
| **Candle / Bar** | A single data point on a chart representing one time period. Contains four values: open, high, low, close (OHLC). |
| **CAPE / Shiller P/E** | Cyclically Adjusted Price-to-Earnings ratio. Uses 10 years of inflation-adjusted earnings to smooth out business cycles. Values > 30 indicate elevated market-wide valuation; values < 15 are historically cheap. Also called "P/E 10". |
| **Confidence** | A 0–100 score combining AI model confidence and rule-based evidence. Higher = more sources agree on the signal. |
| **Confidence floor** | Minimum confidence score for a signal to be considered actionable (default: 65). Signals below this are computed but not stored or alerted. |
| **CPI (Consumer Price Index)** | Measures the average change in prices paid by consumers. The Fed targets 2% YoY. CPI > 5% typically forces rate rises that compress equity multiples. |
| **Death Cross** | EMA 50 crossing below EMA 200 — a widely-watched long-term bearish signal. |
| **Debt-to-Equity (D/E)** | Total debt ÷ stockholders' equity. Measures financial leverage. Higher = more borrowed capital; a D/E > 3 is considered highly leveraged (varies by industry). |
| **Divergence** | Price making a new high/low while an indicator (e.g. RSI) does not. Often precedes a reversal. Not yet used in this system. |
| **EMA (Exponential Moving Average)** | A weighted moving average that gives more weight to recent prices, so it reacts faster than a simple moving average. See [indicators.md](indicators.md#ema--exponential-moving-average). |
| **Entry** | The suggested price at which to open a position. Typically near the current price at signal time. |
| **Fed Funds Rate** | The US Federal Reserve's benchmark overnight lending rate. Higher rates raise borrowing costs and compress equity valuation multiples. |
| **Forward P/E** | Price ÷ consensus analyst EPS estimate for the next 12 months. Lower than trailing P/E implies expected earnings growth. |
| **Golden Cross** | EMA 50 crossing above EMA 200 — a widely-watched long-term bullish signal. |
| **Long** | Buying a security expecting its price to rise. Profit = exit price − entry price. |
| **MACD** | Moving Average Convergence/Divergence — measures momentum via the difference between a fast and slow EMA. See [indicators.md](indicators.md#macd--moving-average-convergencedivergence). |
| **Macro regime** | A qualitative label for the macro environment relative to equities. "Tailwind": low rates, low inflation, positive yield curve. "Headwind": inverted yield curve, high inflation, restrictive Fed. The system applies a confidence-score adjustment based on yield curve, CAPE, and CPI. |
| **OHLCV** | Open, High, Low, Close, Volume — the five values stored for each candle/bar. |
| **Overbought** | Price has risen so fast that buying momentum may be exhausted; a pullback is possible. RSI > 70. |
| **Oversold** | Price has fallen so fast that selling momentum may be exhausted; a bounce is possible. RSI < 30. |
| **P/E ratio (Trailing / TTM)** | Price ÷ actual earnings per share over the past 12 months. A classic valuation measure; context varies heavily by sector. Growth stocks often trade at high P/E; value stocks at low P/E. |
| **R-multiple** | (Target − Entry) ÷ (Entry − Stop). Expresses reward as a multiple of risk. A 2R trade means the potential profit is twice the potential loss. Aim for ≥ 2R. |
| **Resistance** | A price level where selling pressure has historically been strong — like a ceiling. |
| **RSI** | Relative Strength Index — a momentum oscillator on a 0–100 scale. See [indicators.md](indicators.md#rsi--relative-strength-index). |
| **Short** | Selling a security you don't own (borrowing it) expecting its price to fall. Profit = entry price − exit price. |
| **Signal** | In this system: an opportunity detected by the AI and/or rule-based checks for a specific ticker, with a direction (long/short), confidence score, and suggested entry/stop/target. |
| **Stochastic K/D** | A momentum oscillator comparing close price to the recent high-low range (0–100). See [indicators.md](indicators.md#stochastic-k--d). |
| **Stop** | The price at which to exit if the trade goes wrong. Caps your maximum loss. Set at a technically meaningful level (e.g. below support for a long trade). |
| **Support** | A price level where buying interest has historically been strong — like a floor. |
| **Target** | The price goal if the trade goes your way. Sets your profit objective for the R-multiple calculation. |
| **Timeframe** | The period each candle represents. This system uses: 1H (1-hour bars), 4H (4-hour bars), 1D (daily bars). Longer timeframes are less noisy. |
| **Trend** | Sustained directional movement. **Uptrend**: higher highs and higher lows. **Downtrend**: lower highs and lower lows. **Sideways**: neither. |
| **Unemployment rate** | Percentage of the labour force that is jobless and actively seeking work. Context indicator: very low unemployment (< 4%) can signal an overheating economy; very high (> 6%) signals recession risk. |
| **Volume ratio** | Current session volume divided by the 20-day average volume. Normalises volume so any stock can be compared. See [indicators.md](indicators.md#volume-ratio). |
| **Volume spike** | Unusually high volume (> 2× average by default). Often caused by news, earnings, or institutional order flow. |
| **Whipsaw** | A false signal where price briefly moves in one direction then reverses. Multi-timeframe confirmation reduces whipsaws. |
| **Yield curve inversion** | When the 2-year Treasury yield exceeds the 10-year yield (10y-2y spread < 0). Has preceded every US recession since the 1960s. The system marks inverted spreads with a ⚠ and reduces long-signal confidence by 8 points. |

---

## Further reading

- [Investopedia — RSI](https://www.investopedia.com/terms/r/rsi.asp)
- [Investopedia — MACD](https://www.investopedia.com/terms/m/macd.asp)
- [Investopedia — EMA](https://www.investopedia.com/terms/e/ema.asp)
- [Investopedia — Bollinger Bands](https://www.investopedia.com/terms/b/bollingerbands.asp)
- [Investopedia — Support & Resistance](https://www.investopedia.com/trading/support-and-resistance-basics/)
- [Investopedia — R-multiple](https://www.investopedia.com/terms/r/r-multiple.asp)
- [Investopedia — Shiller CAPE](https://www.investopedia.com/terms/s/schiller-pe-ratio.asp)
- [Investopedia — Yield Curve Inversion](https://www.investopedia.com/terms/i/invertedyieldcurve.asp)
- [Investopedia — Debt-to-Equity](https://www.investopedia.com/terms/d/debtequityratio.asp)
- [FRED — Economic data](https://fred.stlouisfed.org/)
