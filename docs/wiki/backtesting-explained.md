# Backtesting — Concepts & Metrics (Plain English)

> **Who is this for?** Anyone who wants to understand what the backtesting tab does without a finance degree. We assume you're comfortable with basic arithmetic. Every term is defined the first time it appears.

---

## What is backtesting?

Imagine you've invented a recipe and you want to know if it would have worked in the past before cooking it for guests. Backtesting does the same thing for trading rules.

We take our signal rules — the logic the app uses to say "buy this stock now" — and we replay them against *historical* price data. We pretend it's the past, let the rules fire signals, then fast-forward to see what actually happened to the price afterwards.

**Plain English version:** "We pretend it's the past and ask: if our system had said 'buy AAPL on March 5', would that have made money?"

### A concrete example

Suppose the system fires a signal on AAPL (Apple) with:
- **Entry price** (the price you buy at): $170
- **Stop price** (if it falls here, you exit to limit your loss): $167
- **Target price** (if it rises here, you take profit and exit): $176

After placing the trade, three things can happen:

| What happens | Outcome | Why |
|---|---|---|
| Price rises to $176 within 10 days | **Win** — you made $6 per share | The target was hit first |
| Price falls to $167 within 10 days | **Loss** — you lost $3 per share | The stop was hit first |
| Neither happens after 10 days | **Timeout** — you exit at whatever the price is on day 10 | Neither target nor stop fired |

The 10-day limit is called the **max hold days** — if neither outcome happens, the trade closes automatically at the market price on day 10. If day 10's price is $172, you exit with a $2 gain (a partial win — neither a clean win nor a loss).

---

## R-multiple — the universal measuring stick

### Why we don't use raw dollars

If you made $500 profit on a trade, was that good? It depends entirely on how much you risked to get it:

- If you risked $500 to make $500, that's a 1:1 payoff — not great.
- If you risked $100 to make $500, that's a 5:1 payoff — excellent.
- If you risked $5,000 to make $500, that's a 10% return — you'd have done better in a savings account.

To compare trades fairly, we express every trade's outcome as a multiple of the **initial risk** (the dollar distance from entry to stop). We call this the **R-multiple**, or just **R**.

### The formula

For a **long trade** (a trade where you profit if the price goes up):

```
R = (exit_price − entry_price) / (entry_price − stop_price)
```

The bottom part — `(entry_price − stop_price)` — is the risk per share, also called **1R**. It's the most you planned to lose per share.

### Worked example

Entry $170, stop $167, target $176.

- **Risk (1R)** = $170 − $167 = **$3 per share**
- **If target hit** at $176: R = ($176 − $170) / $3 = 6/3 = **+2.0R** (you made twice your risk)
- **If stop hit** at $167: R = ($167 − $170) / $3 = −3/3 = **−1.0R** (you lost exactly what you risked)
- **If timeout** at $172: R = ($172 − $170) / $3 = 2/3 = **+0.67R** (a partial win)

### The key insight: break-even maths

With a 2R target (meaning wins are worth +2R and losses are worth −1R), you need to be right only **34% of the time** to break even. Here's the maths:

- 1 win × (+2R) = +2R
- 2 losses × (−1R) = −2R
- Net = 0R — break even, with only 1 win out of 3 trades (33%)

So a 35% win rate with a 2:1 bracket is actually profitable. This is why R-multiples matter more than raw dollars.

---

## Win rate

**Win rate** is the fraction of trades that hit the target price.

```
Win rate = number of wins / total number of trades
```

### Example

You run a backtest and get 10 trades:
- 5 wins (price hit the target)
- 3 losses (price hit the stop)
- 2 timeouts at +0.3R each (price was above entry but didn't reach target)

Win rate = 5 / 10 = **50%**

### The important lesson: high win rate ≠ profitability

Consider two strategies over 10 trades:

**Strategy A (40% win rate, 2R bracket):**
- 4 wins × (+2R) = +8R
- 6 losses × (−1R) = −6R
- **Net = +2R — profitable despite losing more trades than it wins**

**Strategy B (70% win rate, 0.5R bracket — small targets):**
- 7 wins × (+0.5R) = +3.5R
- 3 losses × (−1R) = −3R
- **Net = +0.5R — barely profitable despite a great win rate**

Strategy A makes more money. A high win rate sounds impressive but means nothing without knowing the size of wins versus losses — which is where avg R-multiple comes in.

---

## Average R-multiple

**Average R-multiple** (also called **avg R** or **expectancy**) is the average outcome across all trades, measured in R.

```
Avg R = sum of all individual R values / total number of trades
```

### Worked example

Going back to our 10-trade example:
- 5 wins at +2.0R each
- 3 losses at −1.0R each
- 2 timeouts at +0.3R each

Sum = (5 × 2.0) + (3 × −1.0) + (2 × 0.3) = 10.0 − 3.0 + 0.6 = **+7.6R total**

Avg R = 7.6 / 10 = **+0.76R per trade**

That means: on average, each trade made 76% of the initial risk as profit. That's a genuinely good result.

**The key rule:** if avg R is positive, the strategy has **positive expectancy** — it's expected to make money over many trades, even if individual trades lose.

---

## Sharpe ratio

**Sharpe ratio** measures *consistency* — not just whether you made money, but whether you made it *smoothly* or through wild swings.

Think of two delivery drivers:
- Driver A reliably delivers 10 packages per hour, every hour.
- Driver B delivers 25 packages some hours and 0 in others, averaging 10 per hour.

Both average 10 packages/hour, but Driver A is far more predictable. Sharpe captures this difference.

In our context:
```
Sharpe = avg R / standard deviation of individual R values
```

**Standard deviation** is a measure of how much the individual trade results scatter around the average. High scatter = low Sharpe; tight clustering = high Sharpe.

### Example

Two strategies both have avg R = 0.5:

**Strategy A (Sharpe 1.2):** Most trades land between +0.2R and +0.8R. Consistent. Predictable drawdowns.

**Strategy B (Sharpe 0.3):** Some trades are +5R, many are −1R. Identical average, but you could have a long string of −1R trades before a big winner bails you out. Hard to stay the course emotionally.

**Rule of thumb:**
- Sharpe above 1.0 over 50+ trades: strong and consistent
- Sharpe 0.5–1.0: decent, worth examining
- Sharpe below 0.3: erratic — even if avg R is positive, it's hard to trust

Note: Sharpe computed from fewer than 30 trades is essentially meaningless — a lucky run of 5 trades can produce a Sharpe of 3.0.

---

## Maximum drawdown

**Maximum drawdown** is the worst losing streak — measured from the highest point ever reached to the lowest point that followed, before recovering.

It is measured in R (not dollars), so it's comparable across different account sizes.

### Example

Imagine an equity curve (the running total of R across all trades):

| Trade | R result | Cumulative R |
|---|---|---|
| 1 | +2.0 | +2.0 |
| 2 | +3.0 | +5.0 |
| 3 | +3.0 | +8.0 ← peak |
| 4 | −1.0 | +7.0 |
| 5 | −1.0 | +6.0 |
| 6 | −1.0 | +5.0 |
| 7 | −1.0 | +4.0 |
| 8 | −1.0 | +3.0 ← trough |
| 9 | +2.0 | +5.0 ← recovery begins |

The equity peaked at +8R (after trade 3) and then fell to +3R (after trade 8). Max drawdown = 8 − 3 = **5R**.

### Why it matters

Even if the strategy made money overall, a 5R drawdown means at some point you were sitting on 5 losing bets worth of paper losses. Could you psychologically stay the course? Would you quit and lock in those losses? Max drawdown tells you what emotional test you'd face.

A good strategy makes money *and* keeps drawdowns manageable. Large drawdowns with good avg R can indicate a strategy that works but is too nerve-wracking to trade in practice.

---

## Confidence floor sweep

Each signal the system generates comes with a **confidence score** (0–100%) — a rough measure of how strong the signal is. The **confidence floor** is the minimum score a signal must have to count.

Higher floor = stricter filter = fewer but potentially better-quality signals.

### Example

You run a backtest on 6 months of data across 5 tickers. The system finds 80 signals at floor 0%.

| Floor | Trades | Win rate | Avg R | Verdict |
|---|---|---|---|---|
| 60% | 50 | 48% | +0.30R | Weak edge |
| 70% | 35 | 53% | +0.55R | Solid edge |
| 75% | 22 | 58% | +0.80R | Good edge |
| 80% | 12 | 60% | +1.10R | Great metrics, small sample |
| 90% | 4 | 75% | +1.50R | Looks amazing — 4 trades means nothing |

**The sweet spot** is the highest floor where you still have at least ~30 trades (a rough minimum for statistical reliability). In this example, that's **floor 70%** — solid edge and enough trades to trust the numbers.

At floor 90%, the metrics look incredible, but 4 trades could just be luck. Don't chase those numbers.

The app lets you drag the confidence floor slider *after* the backtest runs and instantly re-computes all metrics without re-running the engine. Use this to find your sweet spot visually.

---

## Virtual wallet — translating R into real dollars

So far all our metrics are in R. That's great for comparing strategies. But at some point you want to know: **what would have happened to an actual $10,000 account?**

The virtual wallet simulation adds position sizing on top of the R-based results.

### Position sizing

The app uses **fixed-fractional sizing**: you risk a fixed percentage of your current balance on each trade. The default is 10%.

**Example:**
- Account balance: $10,000
- Position size: 10% = $1,000 per trade (the amount deployed, not the amount risked)
- Entry $170, stop $167 → risk per share = $3
- Dollar risk per trade = $1,000 × ($3/$170) = $1,000 × 1.76% = **$17.60 risked**

So 1R = $17.60 for this trade.

- **Win at +2R:** profit = $17.60 × 2 = **+$35.20**
- **Loss at −1R:** loss = −$17.60

### Accumulated over 20 trades

Suppose 20 trades average +0.5R each:

Total R = 20 × 0.5 = +10R

Total dollar gain ≈ 20 × $17.60 × 0.5 = **+$176**

On a $10,000 account: +$176 / $10,000 = **+1.76% return**

The wallet section in the results shows the full equity curve in dollars — you can watch how the account balance grew (or fell) trade by trade.

### Buy & hold benchmark

The wallet section also shows a **buy & hold** line — what would have happened if you'd just bought the first ticker at the start of the test window and held until the end. If your strategy's dollar equity curve finishes below the buy & hold line, you'd have been better off doing nothing. This is the honest test.

---

## Cashout rule

### The problem

You have a trade open. By day 3 it's up to +1.83R — nearly at the +2.0R target. Then it reverses hard and on day 5 hits the stop at −1.0R.

You watched a near-win turn into a loss. That's frustrating, and it happens.

### The solution: cashout at R

The **cashout rule** lets you set a threshold — say, **1.5R** — so that any trade which reaches +1.5R of *unrealised profit* (paper profit not yet locked in) immediately exits and records +1.5R as the result.

You give up the remaining 0.5R of the target, but you lock in the gain before the reversal.

### Worked example

- Entry $170, stop $167 → 1R = $3
- Cashout set at 1.5R
- Target set at 2.0R → $176

**Day 3:** price hits $175.50.
- Unrealised R = ($175.50 − $170) / $3 = 5.5/3 = **1.83R**
- 1.83R ≥ 1.5R → cashout fires
- Trade exits at $175.50, recording **+1.5R**

**Without cashout:** price reverses. Day 5, price hits $167 (the stop). Outcome: **−1.0R**.

Cashout converted a −1R loss into a +1.5R win. On this particular trade, it saved 2.5R.

### When not to use cashout

If your signals reliably reach their full target, cashout costs you 0.5R on every winner. Use the comparator (see below) to check: run the same backtest with and without cashout on the same date window and compare avg R. If avg R is higher without cashout, your signals are strong enough not to need it.

**Cashout trades appear in amber** in the trade list, so you can see exactly how many fired.

---

## ATR multiple

**ATR** stands for **Average True Range** — it measures how much a stock's price typically moves in a single day. A stock with ATR = $3 moves about $3 per day on average.

The **ATR multiple** controls how wide your stop is, expressed as a multiple of ATR.

### Example

AAPL has ATR = $3 (moves roughly $3 per day).

| ATR multiple | Stop distance | What it means |
|---|---|---|
| 1.0 | $3.00 away | Tight — one normal day's move hits the stop |
| 1.5 | $4.50 away | Moderate — needs 1.5 typical days to trigger |
| 2.0 | $6.00 away | Wide — needs 2 normal days of adverse move to trigger |

**Tighter stop:**
- Smaller loss when wrong
- But normal daily volatility can hit the stop even when the overall direction was right

**Wider stop:**
- Larger loss when wrong
- Gives the trade more room to breathe through normal volatility

Use the backtest to experiment: try ATR 1.5 vs 2.0 on the same window and compare avg R and max drawdown. The result tells you which suits your signals better.

---

## Reward:Risk ratio (R:R)

**Reward:Risk ratio** (written R:R or RR) answers: for every $1 you risk, how much do you aim to win?

An R:R of 2:1 means your target is $2 away for every $1 your stop is away.

### Formula

```
Target price (long) = entry + R:R × (entry − stop)
```

### Worked example

Entry $170, stop $167 → risk = $3.

| R:R | Target calculation | Target price |
|---|---|---|
| 1.5:1 | $170 + 1.5 × $3 | $174.50 |
| 2.0:1 | $170 + 2.0 × $3 | $176.00 |
| 3.0:1 | $170 + 3.0 × $3 | $179.00 |

**Higher R:R = you can be wrong more often and still profit.** But higher targets are harder to hit, so your win rate will fall. The key question is whether the *improvement* in avg R outweighs the *fall* in win rate. Backtesting tells you.

---

## Max hold days

**Max hold days** is the trade's time limit. If neither the stop nor the target is hit within N calendar days, the trade closes at whatever the market price is on day N.

This avoids trades that drift aimlessly for months, tying up capital.

### Example

Max hold = 10 days. Trade opens at $170 on day 1.

By day 10: price is $172. No target ($176), no stop ($167) was hit.

- The trade exits at $172
- R = ($172 − $170) / $3 = **+0.67R** — a "timeout" with a small gain
- Outcome type: **timeout**

Timeouts count towards avg R just like wins and losses. If timeouts consistently produce small positive R, they are contributing value. If they're producing small negative R, consider tightening your targets or reducing max hold days.

---

## Out-of-sample (OOS) validation

### The exam analogy

Memorising the answers to last year's exam might get you 100% on the practice paper — but it won't help you on the real exam with different questions. Backtesting on the data you used to *choose* your parameters is the same mistake.

- **In-sample testing:** tuning parameters on Jan–Jun data. The metrics look great because your settings were designed around that data.
- **Out-of-sample testing:** locking those parameters, then testing on Jul–Dec data you have never touched. Those results are your honest estimate — they tell you whether your system genuinely has edge or just memorised the past.

### Recommended workflow

| Step | What to do |
|---|---|
| 1. Tune | Run backtests on Jan–Jun. Try different floors, ATR multiples, R:R settings. Use the comparator to pick the best combination. |
| 2. Lock | Write down your chosen parameters. Do not change them. |
| 3. Validate | Set the date window to Jul–Dec. Enable the **Out-of-sample** toggle. Run **once**. |
| 4. Decide | These Jul–Dec metrics are your honest estimate. If they look good, you have real evidence of edge. |

**Important:** if OOS metrics are disappointing, the strategy overfit to the tuning data. Start over with fresh parameters — do not keep tweaking until the OOS window looks good, because then it becomes in-sample too.

---

## Saved configurations (profiles)

A **saved profile** (also called a **saved configuration**) is a named snapshot of all your parameter settings — confidence floor, ATR multiple, R:R, cashout R, position size, initial balance — so you can re-use the same setup without re-entering it.

### Example

You've found good parameters through tuning:
- Floor: 75%
- ATR multiple: 2.0
- R:R: 2.5:1
- Cashout: 1.5R
- Balance: $10,000, position size 10%

Save this as **"Aggressive swing"**.

Next quarter, you want to re-test these exact settings on new dates or new tickers. Click **"Aggressive swing"**, the parameters load instantly, change only the dates, and run. No risk of accidentally changing a setting.

Profiles are stored in your browser's local storage. They are not tied to specific tickers or date windows — those you choose fresh each time.

---

## Past runs and the comparator

### Past runs table

Every backtest you run is saved automatically. The **past runs table** is your experiment log — you can click any row to reload its full results, or select multiple rows to compare them.

Each row now shows:
- The run's parameters and date window
- Key metrics (win rate, avg R, Sharpe)
- **Wallet column:** final balance, dollar P&L, and cashout count

**Example wallet column entry:** `$10,450 / +$450 (+4.5%) / 3 cashouts`

The most recently opened run reloads automatically when you refresh the page.

### Comparator

Select two or more past runs using the checkboxes. The **comparator** overlays them side by side so you can see which set of parameters genuinely performs better.

**Example comparison:**

| Run | Floor | Mode | Avg R | Sharpe | Trades |
|---|---|---|---|---|---|
| Run A | 65% | rules | +0.30R | 0.4 | 48 |
| Run B | 75% | rules | +0.70R | 0.9 | 22 |

Run B has fewer trades but meaningfully better quality metrics. The comparator makes this visually obvious — it overlays the cumulative R curves and highlights the best values in green.

It also shows a **$ portfolio equity overlay**, so you can compare the dollar equity curves of multiple runs on the same chart. If Run B's dollar curve climbs more steeply than Run A's despite fewer trades, it's the better strategy even though it traded less.

The **comparator metrics table** includes after-cost avg R (deducting an estimated fee per trade), Sharpe, max drawdown, and wallet rows — giving you a complete picture of each run's quality.

---

## Quick reference: outcome types

| Outcome | What happened |
|---|---|
| **win** | Price reached the target price |
| **loss** | Price reached the stop price |
| **timeout** | Neither target nor stop was hit within max hold days; exited at the day-N close |
| **cashout** | The cashout rule fired because unrealised profit reached the cashout threshold |

---

## Pitfalls to watch out for

### Overfitting
Testing dozens of parameter combinations and picking the best one is called **overfitting** or **curve-fitting**. The selected parameters fit the historical *noise*, not a genuine pattern. The antidote is OOS validation — see above.

### Small samples
With fewer than ~30 trades, metrics like Sharpe and win rate are statistically noisy. A 3-ticker, 3-month backtest might produce 12 trades — too few to draw conclusions. Use longer date windows or more tickers.

### Daily bar granularity
The engine evaluates outcomes on *daily* bars. It can't model what happened within a single day. A stop and a target could both technically be touched intraday, but the engine uses a conservative tie-break (the stop counts).

### Survivorship bias
If you only test tickers that are in your watchlist *today* — stocks that survived and (probably) did well — you're inadvertently testing winners. A complete test would include tickers that were relevant at the *start* of the test window, including ones that fell out of favour.

---

## Glossary cross-references

- [ATR](glossary.md#atr) — Average True Range
- [Confidence floor](glossary.md#confidence-floor)
- [R-multiple](glossary.md#r-multiple)
- [Sharpe ratio](glossary.md#sharpe-ratio)
- [Max drawdown](glossary.md#max-drawdown)
- [False-positive rate](glossary.md#false-positive-rate)
- [In-sample (IS)](glossary.md#in-sample-is)
- [Out-of-sample (OOS)](glossary.md#out-of-sample-oos)
- [Deployment stage](glossary.md#deployment-stage)
- [Expectancy CI95](glossary.md#expectancy-ci95)
- [Fee stress pass](glossary.md#fee-stress-pass)

---

*See also: [backtesting.md](backtesting.md) — feature reference (parameters, API, runs comparator)*
