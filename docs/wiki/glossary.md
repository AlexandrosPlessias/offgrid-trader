# Trading Glossary

Quick reference for terms used in **MarketSage** and in technical analysis generally.
The same content is available in-app on the **Learn** tab.

> ⚠️ **Not financial advice.** This glossary is for educational purposes only.

---

| Term | Plain English |
|---|---|
| **ATR (Average True Range)** | A measure of how much price typically moves in one period. True Range for each candle = largest of: (High − Low), \|High − Prev Close\|, \|Low − Prev Close\|. ATR is the N-period (usually 14) rolling average of those values. Higher ATR = more volatile asset. |
| **ATR multiple** | The backtest parameter that sets stop-loss width as a multiple of ATR. Default: 2.0. `stop (long) = entry − atr_multiple × ATR`. A wider multiple gives the trade more room but risks more R per loss; a tighter multiple cuts losses faster but causes more premature exits. |
| **ATR-based stop estimate** | When live ATR data is unavailable, the engine estimates ATR from the Bollinger Band width: `ATR ≈ (bb_upper − bb_lower) / 4`. The full band spans ±2σ, so the half-width ≈ 2σ and dividing by 4 gives ≈ σ, a reasonable ATR proxy. |
| **Balance sheet** | A snapshot of what a company owns (assets), what it owes (liabilities), and what remains for shareholders (equity). Filed quarterly; the system uses the most recent annual filing. |
| **Bearish** | Expecting price to fall. A bearish signal suggests a potential short opportunity. |
| **Bollinger Bands** | A volatility envelope around a 20-period moving average (±2 standard deviations). Bands widen in volatile markets and contract in quiet ones. See [indicators.md](indicators.md#bollinger-bands). |
| **Bullish** | Expecting price to rise. A bullish signal suggests a potential long opportunity. |
| **Buy & hold benchmark** | A reference strategy that invests the initial balance equally across all tickers on day one and holds until the end of the window. Shown as an overlay on the $ equity curve. If the strategy's curve is above the benchmark, the signals added alpha. |
| **Candle / Bar** | A single data point on a chart representing one time period. Contains four values: open, high, low, close (OHLC). |
| **CAPE / Shiller P/E** | Cyclically Adjusted Price-to-Earnings ratio. Uses 10 years of inflation-adjusted earnings to smooth out business cycles. Values > 30 indicate elevated market-wide valuation; values < 15 are historically cheap. Also called "P/E 10". |
| **Cashout count** | The number of trades in a backtest run that were closed by the cashout rule rather than hitting target or stop. Shown in the Past Runs table and in the metrics summary. |
| **Cashout rule** | An optional early-exit rule for the virtual wallet. When a trade's unrealised R reaches the cashout threshold (e.g. 1.5 R), the trade closes immediately at that price, locking in partial profit. Prevents a winning trade from reversing into a loss. Trades closed by the cashout rule are marked in amber and count as wins. |
| **Confidence Score** | A 0–100 rating combining AI model confidence and rule-based indicator evidence. Think of it as a vote: the more sources that agree on the signal, the higher the score. See [how-signals-work.md](how-signals-work.md). |
| **Confidence Floor** | The minimum Confidence Score a signal must reach before MarketSage fires an alert or places a paper trade. Set it higher to only act on the strongest signals; lower it to catch more opportunities at the cost of more noise. Default: 65 in live scanning, 75 in backtesting. See [settings.md](settings.md). |
| **CPI (Consumer Price Index)** | Measures the average change in prices paid by consumers. The Fed targets 2% YoY. CPI > 5% typically forces rate rises that compress equity multiples. |
| **Death Cross** | EMA 50 crossing below EMA 200 — a widely-watched long-term bearish signal. |
| **Debt-to-Equity (D/E)** | Total debt ÷ stockholders' equity. Measures financial leverage. Higher = more borrowed capital; a D/E > 3 is considered highly leveraged (varies by industry). |
| **Deployment stage** | A recommendation from the AI Review describing how ready a strategy is for live trading. Stages (most to least cautious): `reject` → `research_only` → `paper_trade` → `limited_live_candidate`. OOS evidence and fee-stress results drive the stage. |
| **Discovery / Trending Discovery** | The automatic process that finds interesting tickers *outside* your watchlist — ones that are trending in news or social feeds. You don't need to know about a stock in advance; the system surfaces it for you. See [trending-discovery.md](trending-discovery.md). |
| **Divergence** | Price making a new high/low while an indicator (e.g. RSI) does not. Often precedes a reversal. Not yet used in this system. |
| **Dollar equity curve** | A chart showing the virtual wallet's running balance over the backtest window. Plotted alongside a buy-and-hold benchmark so you can see at a glance whether following the signals outperformed simply holding the same tickers. |
| **EMA (Exponential Moving Average)** | A weighted moving average that gives more weight to recent prices, so it reacts faster than a simple moving average. See [indicators.md](indicators.md#ema--exponential-moving-average). |
| **Entry** | The suggested price at which to open a position. Typically near the current price at signal time. |
| **Expectancy CI95** | 95 % confidence interval on the expected R per trade, computed via Wilson-score. Wide interval = sample too small to draw conclusions. A tight CI entirely above zero is a strong indicator of edge. |
| **False-positive rate** | In backtesting: `losses / total_trades`. The proportion of signals that triggered a stop-out. Complements win rate. |
| **Fed Funds Rate** | The US Federal Reserve's benchmark overnight lending rate. Higher rates raise borrowing costs and compress equity valuation multiples. |
| **Fee stress pass** | Whether the average R-multiple exceeds the estimated round-trip transaction cost (0.05 R — commissions + spread). A strategy that passes fee stress is viable net of realistic costs; one that fails is only profitable on paper. |
| **Filled Average Price** | If your order executes in more than one batch (e.g. 6 shares at $10.00 then 4 shares at $10.05), this is the weighted average of what you actually paid — not the price you originally requested. Plain English: "the real price you ended up with across all the partial fills." |
| **Forward P/E** | Price ÷ consensus analyst EPS estimate for the next 12 months. Lower than trailing P/E implies expected earnings growth. |
| **Golden Cross** | EMA 50 crossing above EMA 200 — a widely-watched long-term bullish signal. |
| **In-sample (IS)** | A backtest run on the same date window used to select or tune parameters. Metrics are optimistic — the system implicitly "fit" its settings to this data. Use in-sample runs for exploration only; mark them with the toggle OFF. |
| **Long** | Buying a security expecting its price to rise. Profit = exit price − entry price. |
| **MACD** | Moving Average Convergence/Divergence — measures momentum via the difference between a fast and slow EMA. See [indicators.md](indicators.md#macd--moving-average-convergencedivergence). |
| **Macro regime** | A qualitative label for the macro environment relative to equities. "Tailwind": low rates, low inflation, positive yield curve. "Headwind": inverted yield curve, high inflation, restrictive Fed. The system applies a confidence-score adjustment based on yield curve, CAPE, and CPI. |
| **Max drawdown** | In the context of backtesting: the worst peak-to-trough decline of the cumulative R-multiple curve. Reported in R-multiples (not dollars). A max drawdown of 5 R means the system was at one point 5 risk-units below its previous high. |
| **Max hold days** | The maximum number of trading days a backtest trade can stay open. If neither the stop nor the target is hit within this period, the trade closes at the market price on the final day. Default: 10 days. |
| **OHLCV** | Open, High, Low, Close, Volume — the five values stored for each candle/bar. |
| **Overbought** | Price has risen so fast that buying momentum may be exhausted; a pullback is possible. RSI > 70. |
| **Oversold** | Price has fallen so fast that selling momentum may be exhausted; a bounce is possible. RSI < 30. |
| **Out-of-sample (OOS)** | A backtest run on a date window that was never used during parameter tuning. Metrics are an honest estimate of real-world performance. Mark OOS runs with the toggle ON; the AI Review weighs them more heavily and may advance the deployment stage. Run each OOS window only once — a second run after re-tuning makes it in-sample again. |
| **Partially Filled** | Your order to buy or sell shares went through in part but not all the way. For example, you asked to buy 10 shares but only 6 have been matched with a seller so far — the remaining 4 are still waiting. See also: [paper-trading.md](paper-trading.md). |
| **P/E ratio (Trailing / TTM)** | Price ÷ actual earnings per share over the past 12 months. A classic valuation measure; context varies heavily by sector. Growth stocks often trade at high P/E; value stocks at low P/E. |
| **Position size** | The dollar amount committed to each trade in the virtual wallet simulation. Computed as `initial_balance × position_size_pct`. Example: 10 % of $10,000 = $1,000 per trade. A fixed-fractional approach — the amount does not change as the wallet grows or shrinks. |
| **R-multiple** | A trade's profit or loss expressed as a multiple of the initial risk. A stop-out gives R = −1.0; hitting a 2 : 1 target gives R = +2.0. Formula: `R = (exit − entry) / |entry − stop|` (sign-adjusted for shorts). Currency-independent and bracket-independent — aim for ≥ 2R. |
| **R:R (Reward-to-Risk ratio)** | Also `reward_risk`. The ratio of target distance to stop distance. At R:R = 2.0, the target is twice as far from entry as the stop. You need only a 34 % win rate to break even at 2 : 1. |
| **Realised P&L** | The actual profit or loss you locked in once a position fully closed. Until a trade closes, any gain or loss is just "on paper" and can still reverse. Once it closes, the number is real. Plain English: "the money you actually made or lost once you sold." |
| **Resistance** | A price level where selling pressure has historically been strong — like a ceiling. |
| **Risk Level** | A simple label — **low**, **medium**, or **high** — that summarises how dangerous a trade idea is. It is worked out from two things: how wildly the price tends to swing (volatility) and how large the proposed position would be. A high-risk signal does not mean "don't trade" — it means "be aware of the downside." |
| **RSI** | Relative Strength Index — a momentum oscillator on a 0–100 scale. See [indicators.md](indicators.md#rsi--relative-strength-index). |
| **Saved configuration (profile)** | A named snapshot of all backtesting parameters (confidence floor, ATR multiple, R:R, hold days, wallet settings, cashout R, scan interval). Stored in the database — available from any browser or device. Load a profile to instantly restore a known-good parameter set for a new date window or ticker universe. |
| **Scan Interval** | How often the scheduler re-analyses every ticker on your watchlist — for example every 15 minutes, hourly, or once a day. A shorter interval catches moves sooner but uses more AI calls. Configured in [settings.md](settings.md). In backtesting the same setting controls how many signal-detection passes run within each trading day (EOD = one pass at close; finer intervals multiply LLM call count proportionally). |
| **Sharpe ratio** | In backtesting (R-domain): `mean(R) / std(R)`. Risk-adjusted return normalised to units of risk. Values above 0.5 over a meaningful sample (50 + trades) are worth examining; above 1.0 is strong. |
| **Short** | Selling a security you don't own (borrowing it) expecting its price to fall. Profit = entry price − exit price. |
| **Signal** | In this system: an opportunity detected by the AI and/or rule-based checks for a specific ticker, with a direction (long/short), confidence score, and suggested entry/stop/target. |
| **Stochastic K/D** | A momentum oscillator comparing close price to the recent high-low range (0–100). See [indicators.md](indicators.md#stochastic-k--d). |
| **Stop** | The price at which to exit if the trade goes wrong. Caps your maximum loss. Set at a technically meaningful level (e.g. below support for a long trade). |
| **Support** | A price level where buying interest has historically been strong — like a floor. |
| **Target** | The price goal if the trade goes your way. Sets your profit objective for the R-multiple calculation. |
| **Timeframe** | The period each candle represents. This system uses: 1H (1-hour bars), 4H (4-hour bars), 1D (daily bars). Longer timeframes are less noisy. |
| **Trend** | Sustained directional movement. **Uptrend**: higher highs and higher lows. **Downtrend**: lower highs and lower lows. **Sideways**: neither. |
| **Unemployment rate** | Percentage of the labour force that is jobless and actively seeking work. Context indicator: very low unemployment (< 4%) can signal an overheating economy; very high (> 6%) signals recession risk. |
| **Virtual wallet** | A simulated portfolio that runs alongside the R-multiple engine. Each trade invests a fixed dollar amount (position size); the wallet grows or shrinks as trades close. Lets you translate abstract R-metrics into concrete dollar gains and losses. |
| **Volume ratio** | Current session volume divided by the 20-day average volume. Normalises volume so any stock can be compared. See [indicators.md](indicators.md#volume-ratio). |
| **Volume spike** | Unusually high volume (> 2× average by default). Often caused by news, earnings, or institutional order flow. |
| **Whipsaw** | A false signal where price briefly moves in one direction then reverses. Multi-timeframe confirmation reduces whipsaws. |
| **Win rate** | In backtesting: `wins / total_trades`. The fraction of signals that closed at their take-profit target. Above 50 % is not required for profitability at a 2 : 1 reward/risk. |
| **Yield curve inversion** | When the 2-year Treasury yield exceeds the 10-year yield (10y-2y spread < 0). Has preceded every US recession since the 1960s. The system marks inverted spreads with a ⚠ and reduces long-signal confidence by 8 points. |

---

## Order Statuses

Every order you see on the [Trading page](paper-trading.md) carries one of the following status labels. Here is what each one means in plain language.

| Status | Plain-English label | What it means |
|---|---|---|
| `pending_new` | Waiting to be sent | Your request is on its way to the exchange — nothing has happened yet. |
| `accepted` / `held` | In the queue | The exchange received it and is waiting for the right moment to act. |
| `partially_filled` | Half done | Some shares were bought or sold, but the rest is still waiting. |
| `filled` | Done ✓ | All shares bought or sold. The "Filled @" price is what you actually paid or received. |
| `cancelled` | Cancelled | Called off before it could complete. Nothing was bought or sold. |
| `expired` | Ran out of time | Day orders automatically cancel at market close if they were not filled — like a shop closing before you reached the till. |

---

## Further reading

- [Investopedia — RSI](https://www.investopedia.com/terms/r/rsi.asp)
- [Investopedia — MACD](https://www.investopedia.com/terms/m/macd.asp)
- [Investopedia — EMA](https://www.investopedia.com/terms/e/ema.asp)
- [Investopedia — Bollinger Bands](https://www.investopedia.com/terms/b/bollingerbands.asp)
- [Investopedia — Support & Resistance](https://www.investopedia.com/trading/support-and-resistance-basics/)
- [Investopedia — ATR](https://www.investopedia.com/terms/a/atr.asp)
- [Investopedia — R-multiple](https://www.investopedia.com/terms/r/r-multiple.asp)
- [Investopedia — Shiller CAPE](https://www.investopedia.com/terms/s/schiller-pe-ratio.asp)
- [Investopedia — Yield Curve Inversion](https://www.investopedia.com/terms/i/invertedyieldcurve.asp)
- [Investopedia — Debt-to-Equity](https://www.investopedia.com/terms/d/debtequityratio.asp)
- [FRED — Economic data](https://fred.stlouisfed.org/)
