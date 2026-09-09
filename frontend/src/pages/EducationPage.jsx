import { useState } from 'react'

const GLOSSARY_CATEGORIES = [
  {
    id: 'signals',
    label: 'Signals & Analysis',
    icon: '📡',
    terms: [
      ['Confidence',                   '0–100 score combining AI confidence and rule-based evidence. Higher = stronger agreement across sources.'],
      ['Confidence Floor',             'The minimum confidence score a signal must reach before it triggers an alert or paper trade. Setting it high reduces noisy, low-conviction signals; setting it low lets more signals through.'],
      ['Confidence Score',             'A number from 0 to 100 that reflects how strongly the AI and the technical indicators agree on a trade direction. Think of it like a jury vote — the closer to 100, the more votes in favour.'],
      ['Discovery / Trending Discovery', "An automatic process that scans the market for trending tickers you haven't added to your watchlist yet — like a search engine for trading opportunities. Results appear in the Discovery tab."],
      ['Risk Level',                   "A label (low / medium / high) that summarises how risky a trade idea is, based on how wildly the stock's price tends to swing and how large the proposed position would be."],
      ['Scan Interval',                'How often (in minutes) the app automatically re-checks every ticker on your watchlist. A shorter interval means more frequent checks — and more AI tokens used.'],
      ['Trend',                        'Sustained directional movement. Uptrend: higher highs and higher lows. Downtrend: lower highs and lower lows. Sideways: neither.'],
      ['Volume spike',                 'Unusually high volume (> 1.5× average). Often triggered by news, earnings surprises, or institutional order flow.'],
    ],
  },
  {
    id: 'indicators',
    label: 'Technical Indicators',
    icon: '📈',
    terms: [
      ['Bearish',                      'Expecting price to fall. A bearish signal suggests a potential short opportunity.'],
      ['Bullish',                      'Expecting price to rise. A bullish signal suggests a potential long opportunity.'],
      ['Death Cross',                  'EMA 50 crossing below EMA 200 — a long-term bearish signal that often attracts institutional selling.'],
      ['Golden Cross',                 'EMA 50 crossing above EMA 200 — a long-term bullish signal widely watched by institutional traders.'],
      ['OHLCV',                        'Open, High, Low, Close, Volume — the five values in a price candle. Every bar on a chart encodes these.'],
      ['Resistance',                   'A price level where selling pressure has historically been strong — like a ceiling the price struggles to break through.'],
      ['Support',                      'A price level where buying interest has historically been strong — like a floor the price bounces off.'],
      ['Timeframe',                    '1H = each candle covers 1 hour. 4H = 4 hours. 1D = one full trading day. Longer timeframes filter more noise.'],
    ],
  },
  {
    id: 'trade-mechanics',
    label: 'Trade Mechanics',
    icon: '⚙️',
    terms: [
      ['Entry',                        'Suggested price at which to open the position. Typically near the current price at signal time.'],
      ['Long',                         'Buying a security expecting its price to rise. Profit = price at exit − price at entry.'],
      ['R-multiple',                   '(Target − Entry) ÷ (Entry − Stop). A 2R trade means your potential profit is twice your risk. Aim for ≥ 2R.'],
      ['Short',                        "Selling a security you don't own (borrowing it) expecting its price to fall. Profit = price at entry − price at exit."],
      ['Stop',                         'The price at which to exit if the trade goes wrong. Caps your loss. Set it at a technically significant level (e.g. below support).'],
      ['Target',                       'The price goal if the trade goes your way. Sets your reward level for the R-multiple calculation.'],
    ],
  },
  {
    id: 'paper-trading',
    label: 'Paper Trading & Orders',
    icon: '🧾',
    terms: [
      ['Filled Average Price',         'If your order was filled in multiple smaller batches at slightly different prices, this is the weighted average of what you actually paid or received. Think of it like splitting a restaurant bill across two cards and averaging the totals.'],
      ['Partially Filled',             "You asked to buy 10 shares, but only 6 went through so far. The other 4 are still waiting. This happens when there aren't enough sellers at your price right at that moment."],
      ['Realised P&L',                 'The money you actually made or lost once you closed a position. While you still hold shares, any gain or loss is "unrealised" — on paper only. Once you sell, it becomes realised: real cash.'],
    ],
  },
  {
    id: 'macro',
    label: 'Macro & Fundamentals',
    icon: '🌍',
    terms: [
      ['CAPE / Shiller P/E',           '10-year inflation-adjusted P/E ratio for the S&P 500 as a whole. Values above 30 indicate elevated market-wide valuation; below 15 is historically cheap. Used in the macro regime filter (Rule 6).'],
      ['CPI',                          'Consumer Price Index — measures the rate of consumer price inflation. The Fed targets 2% YoY. High CPI forces the Fed to keep rates elevated, which compresses equity valuation multiples. Shown in the Macro card.'],
      ['Debt-to-Equity (D/E)',         "Total debt divided by stockholders' equity. Measures financial leverage. High D/E amplifies both gains and losses in downturns. A D/E above 3 is considered highly leveraged; context varies by sector (utilities and banks naturally carry more debt)."],
      ['Fed Funds Rate',               "The US Federal Reserve's benchmark overnight lending rate. Higher rates raise borrowing costs across the economy and compress equity valuation multiples by making bonds relatively more attractive."],
      ['Forward P/E',                  'Price divided by consensus analyst EPS estimate for the next 12 months. A forward P/E lower than the trailing P/E implies the market expects earnings growth; higher implies expected contraction.'],
      ['Macro regime',                 '"Tailwind" conditions: low rates, low inflation, normal (upward-sloping) yield curve. "Headwind" conditions: inverted yield curve, high inflation, restrictive Fed. Rule 6 adjusts opportunity confidence scores accordingly.'],
      ['Trailing P/E (TTM)',           'Price divided by actual earnings over the trailing twelve months. A classic valuation measure. Context varies heavily by sector. Negative P/E (loss-making companies) cannot be interpreted as "cheap".'],
      ['Yield curve inversion',        'When the 2-year US Treasury yield exceeds the 10-year yield, the curve is "inverted". Has preceded every US recession since the 1960s. Shown with ⚠ in the Macro card; applies −8 confidence to long signals (Rule 6).'],
    ],
  },
]

// Backward-compat flat array for anything that imports GLOSSARY_TERMS directly
const GLOSSARY_TERMS = GLOSSARY_CATEGORIES.flatMap(c => c.terms)

function GlossarySection() {
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const filtered = q
    ? GLOSSARY_TERMS.filter(([term, def]) =>
        term.toLowerCase().includes(q) || def.toLowerCase().includes(q))
    : null

  return (
    <EduSection id="edu-glossary" title="Trading glossary" badge="Glossary">
      <div className="gls-search-wrap">
        <input
          className="gls-search"
          type="search"
          placeholder="Search terms…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {q && (
          <span className="gls-count">{filtered.length} of {GLOSSARY_TERMS.length}</span>
        )}
      </div>

      {/* ── Search active: flat filtered results ──────────────────────────── */}
      {q && (
        filtered.length === 0
          ? <p className="section-desc" style={{ color: 'var(--dim)' }}>No terms match "{query}".</p>
          : (
            <table className="edu-glossary-table">
              <tbody>
                {filtered.map(([term, def]) => (
                  <tr key={term}>
                    <td className="gls-term">{term}</td>
                    <td className="gls-def">{def}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {/* ── No search: categorised collapsible sections ───────────────────── */}
      {!q && GLOSSARY_CATEGORIES.map((cat, idx) => (
        <details key={cat.id} className="gls-category" open={idx === 0}>
          <summary className="gls-category-summary">
            <span className="gls-cat-icon">{cat.icon}</span>
            <span className="gls-cat-label">{cat.label}</span>
            <span className="gls-cat-count">({cat.terms.length})</span>
          </summary>
          <table className="edu-glossary-table">
            <tbody>
              {cat.terms.map(([term, def]) => (
                <tr key={term}>
                  <td className="gls-term">{term}</td>
                  <td className="gls-def">{def}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </EduSection>
  )
}

function EduSection({ id, title, badge, children, defaultOpen = false }) {
  return (
    <details id={id} className="edu-section" open={defaultOpen}>
      <summary className="edu-summary">
        <span className="edu-summary-title">{title}</span>
        {badge && <span className="section-badge edu-badge-right">{badge}</span>}
        <span className="edu-chevron">›</span>
      </summary>
      <div className="edu-section-body">{children}</div>
    </details>
  )
}

const EDU_SECTIONS = [
  { id: 'edu-pipeline',      label: 'Pipeline' },
  { id: 'edu-indicators',    label: 'Indicators' },
  { id: 'edu-fundamentals',  label: 'Fundamentals' },
  { id: 'edu-rules',         label: 'Rules' },
  { id: 'edu-signals',       label: 'How scores work' },
  { id: 'edu-backtesting',   label: 'Backtesting' },
  { id: 'edu-paper-trading', label: 'Paper Trading' },
  { id: 'edu-glossary',      label: 'Glossary' },
  { id: 'edu-further',       label: 'Further reading' },
]

export default function EducationPage() {
  const scrollTo = (id) => {
    const el = document.getElementById(id)
    if (!el) return
    el.open = true                                          // expand the <details>
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="education-layout">
      {/* ── Sticky TOC sidebar ─────────────────────────────────────────────── */}
      <nav className="edu-toc">
        <div className="edu-toc-title">Contents</div>
        {EDU_SECTIONS.map(s => (
          <button key={s.id} className="edu-toc-link" onClick={() => scrollTo(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <div className="education-page">
        <div className="edu-header">
          <h1 className="edu-title">📚 How it works</h1>
          <p className="edu-subtitle">
            A plain-English guide to the system: what data it fetches, what each indicator
            measures, how it detects opportunities, and what the trading terms mean.
          </p>
          <p className="edu-expand-hint">Click any section header to expand or collapse it.</p>
        </div>

      {/* Section 1 — Pipeline */}
      <EduSection id="edu-pipeline" title="The analysis pipeline" badge="Pipeline">
        <p className="section-desc">
          Every analysis — whether triggered by the scheduler or an ad-hoc run — flows
          through the same eight steps:
        </p>
        <ol className="edu-steps">
          <li>
            <strong>yfinance</strong> — fetches live price, volume, day change, fundamentals
            (name, sector, industry, market cap, P/E trailing + forward) and 20-day averages.
            Free, no API key. The annual balance sheet is also fetched here (daily cache).
            Price data is cached permanently per day — within a trading session the same
            snapshot is returned instantly, and the data is kept for backtesting replay.
          </li>
          <li>
            <strong>yfinance + ta library</strong> — OHLCV history is downloaded for three
            timeframes (1H, 4H, 1D) and all indicators (RSI, MACD, EMA 20/50/200, Bollinger
            Bands, Stochastic) are computed locally using the open-source{' '}
            <code>ta</code> library. No account or API key needed; fully offline.
            Indicator results are cached permanently per day — the RSI/MACD/EMA values
            seen during a scan are stored as the historical snapshot for that date.
          </li>
          <li>
            <strong>FRED + multpl.com</strong> — US macro context is fetched from the Federal
            Reserve's key-free CSV API (Fed funds rate, CPI, unemployment, yield curve) and
            Shiller CAPE from multpl.com. Cached globally for 6 hours across all tickers.
          </li>
          <li>
            <strong>Google News RSS + Finnhub</strong> — recent company news from two
            channels. <strong>Google News RSS</strong> is always active and requires no API
            key. <strong>Finnhub</strong> (optional) adds additional headlines when a free{' '}
            <code>FINNHUB_API_KEY</code> is set. Both feeds are deduplicated, then each
            headline is scored by <strong>VADER</strong> (a lexicon-based sentiment model
            that runs fully offline). The aggregate sentiment (Bullish / Bearish / Mixed /
            Neutral) and score are injected into the AI prompt, and a ±1–3 pt confidence
            adjustment is applied to matching opportunities.
          </li>
          <li>
            <strong>AI analysis</strong> — all of the above (price, indicators, balance
            sheet health, macro environment, P/E, recent news) is assembled into a structured
            prompt and sent to the configured LLM provider: <strong>local Ollama</strong> (default,
            nothing leaves your machine), or a cloud provider (<strong>Groq · Gemini · Mistral · custom</strong>)
            — configured in Settings → AI Provider. When LLM is disabled the pipeline continues
            with rules only (the AI reasoning section in Explorer shows a blur overlay).
            Every LLM call is traced in Aspire with token counts and TTFT.
          </li>
          <li>
            <strong>Rule-based opportunity detection</strong> — four deterministic checks run
            on top of the AI output (see the "How opportunities are detected" section below).
            Belt-and-suspenders: the rules catch signals the model might miss and provide
            auditable logic.
          </li>
          <li>
            <strong>Confidence scoring</strong> — AI confidence and rule-based evidence are
            merged into a 0–100 score. Only signals at or above the confidence floor
            (default: 65) are marked actionable.
          </li>
          <li>
            <strong>SQLite persistence</strong> — every analysis and actionable signal is
            stored locally in <code>data/offgrid_trader.db</code>. Queryable via the
            Recent Signals table on the Dashboard or the API endpoints.
          </li>
        </ol>
        <p className="section-desc" style={{ marginTop: 10 }}>
          The <strong>Analysis Explorer</strong> page shows you this pipeline live — each
          step completes in real time and you can inspect the data at every stage.
        </p>
      </EduSection>

      {/* Section 2 — Indicators */}
      <EduSection id="edu-indicators" title="Technical indicators explained" badge="Indicators">
        <p className="section-desc">
          Technical indicators are mathematical formulas applied to price and volume history.
          They compress raw data into numbers that are easier to compare and pattern-match.
          No indicator is reliable alone — the system checks agreement across three timeframes
          and multiple indicators before raising a signal.
        </p>

        <div className="edu-indicator-grid">
          <div className="edu-indicator-card">
            <div className="edu-ind-name">RSI — Relative Strength Index</div>
            <div className="edu-ind-scale">Scale: 0 → 100</div>
            <p>
              Measures how fast price has been moving. Calculated as the ratio of
              average up-days to average down-days over 14 periods.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&lt; 30</span> — Oversold. Price fell quickly; may bounce back.</li>
              <li><span className="lvl-dim">30–70</span> — Neutral zone. No extreme reading.</li>
              <li><span className="lvl-red">&gt; 70</span> — Overbought. Price rose quickly; may pull back.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>What this system checks:</strong> RSI extreme (&lt;30 or &gt;70) on
              2 or more of the three timeframes simultaneously.
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">MACD — Moving Average Convergence/Divergence</div>
            <div className="edu-ind-scale">Three components: MACD line · Signal line · Histogram</div>
            <p>
              MACD line = 12-period EMA minus 26-period EMA. Signal line = 9-period EMA of
              MACD. Histogram = MACD minus Signal — this is what the chart shows.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">Histogram &gt; 0</span> — Upward momentum building.</li>
              <li><span className="lvl-red">Histogram &lt; 0</span> — Downward momentum building.</li>
              <li><span className="lvl-dim">Histogram crossing zero</span> — Momentum shift; key event.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>What this system checks:</strong> MACD above/below its signal line
              on both the 1D and 4H timeframes (cross-timeframe confirmation).
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">EMA — Exponential Moving Average</div>
            <div className="edu-ind-scale">Three periods: EMA 20 · EMA 50 · EMA 200</div>
            <p>
              A weighted average of past prices that gives more weight to recent data.
              Reacts faster than a simple moving average.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">Price &gt; EMA</span> — Bullish: price is above its average.</li>
              <li><span className="lvl-red">Price &lt; EMA</span> — Bearish: price is below its average.</li>
              <li><span className="lvl-dim">EMA 50 crosses above EMA 200</span> — "Golden Cross" — strong long-term bullish signal.</li>
              <li><span className="lvl-dim">EMA 50 crosses below EMA 200</span> — "Death Cross" — long-term bearish.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>What this system checks:</strong> Whether current price is above or
              below each EMA (shown as % deviation in the Explorer charts).
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">Bollinger Bands</div>
            <div className="edu-ind-scale">Three bands: Upper · Middle (MA20) · Lower</div>
            <p>
              The middle band is a 20-period moving average. Upper and lower bands are
              ±2 standard deviations from the middle — they expand in volatile markets and
              contract in quiet ones.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-red">Price at upper band</span> — Potentially overbought.</li>
              <li><span className="lvl-green">Price at lower band</span> — Potentially oversold.</li>
              <li><span className="lvl-dim">Band squeeze</span> — Low volatility; breakout often follows.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>What this system checks:</strong> BB values are included in the raw
              indicator table (Explorer → expand "Raw indicator data"). Not used in the
              current rule-based detection, but visible to the AI in the prompt.
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">Stochastic K% / D%</div>
            <div className="edu-ind-scale">Scale: 0 → 100</div>
            <p>
              Compares the closing price to the recent high-low range over 14 periods.
              K% is the raw value; D% is a 3-period smoothing of K%.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&lt; 20</span> — Oversold (similar to RSI &lt; 30).</li>
              <li><span className="lvl-red">&gt; 80</span> — Overbought (similar to RSI &gt; 70).</li>
              <li><span className="lvl-dim">K crossing D</span> — Momentum signal.</li>
            </ul>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">Volume ratio</div>
            <div className="edu-ind-scale">Current volume ÷ 20-day average volume</div>
            <p>
              Raw volume is hard to interpret alone — 5M shares is unremarkable for AAPL
              but enormous for a small-cap. The ratio normalises it.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&gt; 1.5×</span> — Unusual activity. Often driven by news, earnings, or institutional orders.</li>
              <li><span className="lvl-dim">≈ 1×</span> — Normal trading day.</li>
              <li><span className="lvl-red">&lt; 0.5×</span> — Low-conviction move; treat signals with caution.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>What this system checks:</strong> Volume ≥ spike multiplier × average
              AND day move ≥ significant-move threshold (both configurable in <code>.env</code>).
            </p>
          </div>
        </div>
      </EduSection>

      {/* Section 3 — Fundamentals, balance sheet & macro */}
      <EduSection id="edu-fundamentals" title="Fundamentals, balance sheet & macro context" badge="Fundamentals">
        <p className="section-desc">
          In addition to technical indicators, the AI prompt includes company fundamentals,
          balance-sheet health, and US macroeconomic context. These give the model a broader
          view of <em>why</em> a price is moving — not just <em>how</em>.
        </p>

        <div className="edu-indicator-grid">
          <div className="edu-indicator-card">
            <div className="edu-ind-name">P/E Ratio — Trailing (TTM)</div>
            <div className="edu-ind-scale">Price ÷ Earnings per share (last 12 months)</div>
            <p>
              Measures how much investors pay for each dollar of current earnings. A higher
              P/E means the market expects strong future growth; a lower P/E may mean
              undervaluation or earnings concern.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&lt; 15</span> — Cheap by historical standards.</li>
              <li><span className="lvl-dim">15–25</span> — Fair value range for most sectors.</li>
              <li><span className="lvl-red">&gt; 35</span> — Elevated; growth expectations are high.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> yfinance <code>.info["trailingPE"]</code>. Shown in the Explorer Fundamentals card and included in the AI prompt VALUATION block.
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">P/E Ratio — Forward</div>
            <div className="edu-ind-scale">Price ÷ Consensus EPS estimate (next 12 months)</div>
            <p>
              Uses analyst earnings forecasts rather than reported results. Forward P/E
              is often lower than trailing if growth is expected, and is more forward-looking
              than the TTM ratio.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-dim">Forward &lt; Trailing</span> — Earnings growth expected.</li>
              <li><span className="lvl-red">Forward &gt; Trailing</span> — Earnings are expected to shrink.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> yfinance <code>.info["forwardPE"]</code>. May be absent for companies without analyst coverage.
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">Shiller CAPE (P/E 10)</div>
            <div className="edu-ind-scale">Price ÷ 10-year average inflation-adjusted earnings</div>
            <p>
              Developed by Nobel laureate Robert Shiller. Smooths out business-cycle
              fluctuations by averaging 10 years of real earnings. Used to gauge overall
              market valuation, not individual stocks.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&lt; 20</span> — Historically cheap market.</li>
              <li><span className="lvl-dim">20–30</span> — Fair-value range (long-run average ≈ 17).</li>
              <li><span className="lvl-red">&gt; 30</span> — Elevated; corrections are historically more likely.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> multpl.com (monthly scrape, 24h cache). Applies to the S&P 500 market as a whole and gives the AI macro valuation context.
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">Debt-to-Equity (D/E)</div>
            <div className="edu-ind-scale">Total debt ÷ Stockholders' equity</div>
            <p>
              Measures financial leverage. A higher ratio means the company finances more
              of its assets with debt — which amplifies both profits and losses.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&lt; 1.0</span> — Conservative; more equity than debt.</li>
              <li><span className="lvl-dim">1.0–2.0</span> — Moderate leverage; common in many sectors.</li>
              <li><span className="lvl-red">&gt; 3.0</span> — Highly leveraged; sensitive to rate rises.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> yfinance annual balance sheet (daily cache). Shown in the Explorer Balance Sheet card.
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">Fed Funds Rate</div>
            <div className="edu-ind-scale">US Federal Reserve overnight lending rate (%)</div>
            <p>
              The rate banks charge each other for overnight loans — the benchmark for
              all other interest rates in the economy. Higher rates increase borrowing
              costs, compress equity valuations, and slow growth.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">Low (&lt; 2%)</span> — Accommodative; cheap money, supports equity multiples.</li>
              <li><span className="lvl-red">High (&gt; 4%)</span> — Restrictive; hurts growth stocks and highly indebted companies.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> FRED series <code>FEDFUNDS</code> (key-free CSV, 6h cache).
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">CPI YoY (Inflation)</div>
            <div className="edu-ind-scale">Year-over-year % change in the Consumer Price Index</div>
            <p>
              The percentage change in the prices of a basket of consumer goods over the
              past year. High inflation erodes purchasing power and prompts central banks
              to raise rates, which can pressure equity markets.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&lt; 2%</span> — Fed target; stable environment.</li>
              <li><span className="lvl-dim">2–4%</span> — Mildly elevated; watch for rate moves.</li>
              <li><span className="lvl-red">&gt; 5%</span> — High inflation; central bank likely tightening.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> FRED series <code>CPIAUCSL</code> — YoY% computed from the last 13 monthly observations.
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">10y-2y Yield Spread</div>
            <div className="edu-ind-scale">10-year Treasury yield minus 2-year Treasury yield</div>
            <p>
              Normally the 10-year rate is higher than the 2-year (the yield curve is
              "normal"). When the 2-year exceeds the 10-year, the curve <strong>inverts</strong>.
              Yield curve inversions have preceded every US recession since the 1960s.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">Positive</span> — Normal curve; healthy growth expectations.</li>
              <li><span className="lvl-red">Negative (inverted)</span> — Recession signal. Shown with ⚠ in the Macro card.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> FRED series <code>T10Y2Y</code> (daily data, 6h cache).
            </p>
          </div>

          <div className="edu-indicator-card">
            <div className="edu-ind-name">Unemployment Rate</div>
            <div className="edu-ind-scale">% of the labour force actively seeking work</div>
            <p>
              A lagging indicator of economic health. Low unemployment typically signals
              a strong economy (bullish for equities). Very low unemployment can also
              feed wage inflation, prompting the Fed to keep rates elevated.
            </p>
            <ul className="edu-ind-levels">
              <li><span className="lvl-green">&lt; 4%</span> — Strong labour market.</li>
              <li><span className="lvl-dim">4–6%</span> — Near long-run average.</li>
              <li><span className="lvl-red">&gt; 6%</span> — Weakening; watch for policy response.</li>
            </ul>
            <p className="edu-ind-check">
              <strong>Source:</strong> FRED series <code>UNRATE</code> (monthly data, 6h cache).
            </p>
          </div>
        </div>
      </EduSection>

      {/* Section 5 — Opportunity detection rules */}
      <EduSection id="edu-rules" title="How opportunities are detected" badge="Rules">
        <p className="section-desc">
          After the AI analysis runs, five independent rule-based checks are applied to the
          same market data. Any check that fires creates a candidate signal. Candidates for the
          same ticker are merged and their confidence scores are combined. Two post-merge
          adjusters (macro regime and news sentiment) then fine-tune the final score.
        </p>

        <div className="edu-rules">
          {[
            {
              num: 1, icon: '🤖', title: 'AI signal',
              side: 'both', conf: '20–90 (ordinal)',
              trigger: 'LLM selects a backend-precomputed plan with confidence ≥ floor',
              body: <>
                The backend pre-computes two candidate trade plans (long and short) using the current price and an ATR-based stop estimate. The LLM classifies the setup as <code>long</code>, <code>short</code>, or <code>none</code>, assigns a raw confidence score (20–90, multiples of 5), and selects a <code>plan_id</code> — it never calculates price levels itself.
                {' '}Entry, stop, and target are resolved from the selected plan. The confidence band (very_low → very_high) and reason code are returned alongside the score.
                {' '}If confidence ≥ the floor (default: 65) and a plan is selected, a candidate is raised.
              </>,
            },
            {
              num: 2, icon: '📊', title: 'RSI extreme (multi-timeframe)',
              side: 'both', conf: '55–85',
              trigger: 'RSI <30 or >70 on 2+ of 1H / 4H / 1D',
              body: <>RSI oversold (&lt;30 = potential long) or overbought (&gt;70 = potential short) on <strong>2 or more</strong> of the 1H / 4H / 1D timeframes simultaneously. Single-timeframe extremes are ignored — too common to be meaningful on their own.</>,
            },
            {
              num: 3, icon: '📈', title: 'MACD crossover (cross-timeframe)',
              side: 'both', conf: '62',
              trigger: 'MACD above/below signal on both 1D and 4H',
              body: <>MACD above its signal line on <strong>both</strong> 1D and 4H = bullish candidate. MACD below on both = bearish. Requiring both timeframes filters out noisy intra-day whipsaws.</>,
            },
            {
              num: 4, icon: '🔊', title: 'Volume spike + significant move',
              side: 'both', conf: '55–80',
              trigger: 'Volume ≥ 2× avg AND price move ≥ 2%',
              body: <>Volume ≥ <code>VOLUME_SPIKE_MULTIPLIER</code>× 20-day average <em>and</em> the day's price move ≥ <code>SIGNIFICANT_MOVE_PCT</code>% (both set in <code>.env</code>). A large move on high volume is more likely to be sustained than one on thin volume.</>,
            },
            {
              num: 5, icon: '💰', title: 'Valuation extreme (P/E)',
              side: 'both', conf: '40–42',
              trigger: 'TTM P/E > 60 (short) or 0 < P/E < 8 (long)',
              body: <><strong>P/E &gt; 60×</strong> → low-confidence short ("severely overvalued"). <strong>P/E &lt; 8×</strong> (positive) → low-confidence long ("deeply discounted"). Confidence intentionally low — reinforces but never drives a signal. Negative P/E (loss-making) is skipped.</>,
            },
            {
              num: 6, icon: '🌍', title: 'Macro regime filter',
              side: 'adjust', conf: '±3 to ±8',
              trigger: 'Post-merge confidence adjuster — yield curve, CAPE, CPI',
              body: <><strong>Yield curve inverted</strong>: long −8, short +3. <strong>CAPE &gt; 35</strong>: long −5, short +3. <strong>CAPE &lt; 15</strong>: long +5, short −3. <strong>CPI &gt; 5%</strong>: long −5. Clamped to 0–100; confidence floor applies afterwards.</>,
            },
            {
              num: 7, icon: '📰', title: 'News sentiment (VADER)',
              side: 'adjust', conf: '±1 to ±3',
              trigger: 'Post-merge confidence adjuster — Google News RSS + Finnhub, VADER-scored',
              body: <>Headlines from <strong>Google News RSS</strong> (always active) and <strong>Finnhub</strong> (optional) are deduplicated, then scored by <strong>VADER</strong> — a lexicon-based sentiment model that runs fully offline. The aggregate compound score (−1.0 to +1.0) adjusts confidence:
                {' '}<strong>score &gt; +0.35</strong>: long +3, short −3 (strong bullish).
                {' '}<strong>score &gt; +0.15</strong>: long +1, short −1 (mild bullish).
                {' '}<strong>score &lt; −0.15</strong>: long −1, short +1 (mild bearish).
                {' '}<strong>score &lt; −0.35</strong>: long −3, short +3 (strong bearish).
                {' '}<strong>Mixed</strong> or <strong>Neutral</strong> → no adjustment. The aggregate score is also injected into the AI prompt so the model weighs it qualitatively.
              </>,
            },
          ].map(({ num, icon, title, side, conf, trigger, body }) => (
            <div key={num} className="edu-rule edu-rule-v2">
              <div className="edu-rule-header">
                <span className="edu-rule-num">{num}</span>
                <span className="edu-rule-icon">{icon}</span>
                <span className="edu-rule-title">{title}</span>
                <span className={`edu-rule-side edu-rule-side-${side}`}>
                  {side === 'both' ? 'long & short' : side === 'adjust' ? 'adjuster' : side}
                </span>
                <span className="edu-rule-conf">conf {conf}</span>
              </div>
              <div className="edu-rule-trigger">⚡ Fires when: {trigger}</div>
              <div className="edu-rule-body">{body}</div>
            </div>
          ))}
        </div>

        <p className="section-desc" style={{ marginTop: 16 }}>
          When multiple rules fire for the same ticker, signals are merged and confidence scores
          are boosted by each additional agreeing rule. Rules 6 and 7 run post-merge as adjusters.
          The final score must still clear the confidence floor to be actionable.
        </p>
      </EduSection>

      {/* Section 6 — How confidence scores are built */}
      <EduSection id="edu-signals" title="How confidence scores are built" badge="Scores">
        <p className="section-desc">
          Every opportunity goes through a transparent, auditable scoring pipeline.
          The final confidence is built in five steps:
        </p>

        <div className="edu-score-steps">
          <div className="edu-score-step">
            <span className="edu-score-num">1</span>
            <div>
              <strong>Individual rule checks</strong> — each fires independently with its own raw confidence:
              <ul className="edu-ind-levels" style={{ marginTop: 8 }}>
                <li><strong>AI model</strong> — ordinal 20–90 (multiples of 5); mapped from confidence_band: very_low 20–35, low 40–50, moderate 55–65, high 70–80, very_high 85–90. Must beat the floor.</li>
                <li><strong>RSI extreme</strong> — 55 + 10 × count (2+ timeframes oversold/overbought). Max 85.</li>
                <li><strong>Volume spike</strong> — 55 + min(ratio, 5) × 3. Max 80.</li>
                <li><strong>MACD crossover</strong> — fixed 62 (both 1D and 4H must agree).</li>
                <li><strong>Valuation extreme</strong> — 40–42 (intentionally low; reinforces, never drives).</li>
              </ul>
            </div>
          </div>

          <div className="edu-score-step">
            <span className="edu-score-num">2</span>
            <div>
              <strong>Merge & corroboration bonus</strong> — same-direction candidates are merged:
              <div className="edu-formula">
                confidence = max(individual scores) + 5 × (number of sources − 1)
              </div>
              <em>Example — AAPL long with AI 72 · RSI 75 · MACD 62:</em><br/>
              base = <strong>75</strong>, bonus = +10 (3 sources × 5), pre-macro = <strong>85</strong>
            </div>
          </div>

          <div className="edu-score-step">
            <span className="edu-score-num">3</span>
            <div>
              <strong>Macro regime filter</strong> — adjusted ±pts based on economic conditions:
              <table className="edu-macro-table">
                <thead><tr><th>Condition</th><th>Long</th><th>Short</th></tr></thead>
                <tbody>
                  <tr><td>Yield curve inverted</td><td className="macro-neg">−8</td><td className="macro-pos">+3</td></tr>
                  <tr><td>Shiller CAPE &gt; 35</td><td className="macro-neg">−5</td><td className="macro-pos">+3</td></tr>
                  <tr><td>Shiller CAPE &lt; 15</td><td className="macro-pos">+5</td><td className="macro-neg">−3</td></tr>
                  <tr><td>CPI YoY &gt; 5%</td><td className="macro-neg">−5</td><td>no change</td></tr>
                </tbody>
              </table>
              Continuing the AAPL example: CAPE 37 → −5. Post-macro = <strong>80</strong>
            </div>
          </div>

          <div className="edu-score-step">
            <span className="edu-score-num">4</span>
            <div>
              <strong>News sentiment filter (VADER)</strong> — adjusted ±pts based on VADER aggregate score:
              <table className="edu-macro-table">
                <thead><tr><th>Condition</th><th>Long</th><th>Short</th></tr></thead>
                <tbody>
                  <tr><td>Score &gt; +0.35 (strong bullish)</td><td className="macro-pos">+3</td><td className="macro-neg">−3</td></tr>
                  <tr><td>Score &gt; +0.15 (mild bullish)</td><td className="macro-pos">+1</td><td className="macro-neg">−1</td></tr>
                  <tr><td>Score &lt; −0.15 (mild bearish)</td><td className="macro-neg">−1</td><td className="macro-pos">+1</td></tr>
                  <tr><td>Score &lt; −0.35 (strong bearish)</td><td className="macro-neg">−3</td><td className="macro-pos">+3</td></tr>
                  <tr><td>Mixed or Neutral</td><td>no change</td><td>no change</td></tr>
                </tbody>
              </table>
              Continuing the AAPL example: Bullish sentiment +0.38 → +3. Final = <strong>83</strong>
            </div>
          </div>

          <div className="edu-score-step">
            <span className="edu-score-num">5</span>
            <div>
              <strong>Confidence floor filter</strong> — any signal below the floor (default: 65) is
              discarded and never stored or alerted. This is why the valuation rule (40–42) cannot
              fire alone — it must stack with 2+ other sources to clear the floor.
            </div>
          </div>
        </div>

        <div className="edu-callout">
          <strong>See it live:</strong> open any analysis in the <em>Analysis Explorer</em> and
          scroll to <em>Opportunity score computation</em> — every rule contribution, corroboration
          bonus, macro adjustment, and sentiment adjustment is shown per signal.
        </div>

        <h4 className="edu-h4">Final opportunity score reference</h4>
        <p className="section-desc" style={{ marginBottom: 8 }}>
          The merged opportunity score (0–100) is built from rule contributions and the corroboration bonus.
          The AI's raw score (20–90) feeds into this as one input.
        </p>
        <table className="edu-table">
          <thead><tr><th>Score</th><th>Interpretation</th></tr></thead>
          <tbody>
            <tr><td style={{color:'var(--red)'}}>{'< 65'}</td><td>Below floor — never stored or alerted</td></tr>
            <tr><td>65–74</td><td>Weak — one rule, mild corroboration</td></tr>
            <tr><td>75–84</td><td>Moderate — multiple agreeing sources or strong single rule</td></tr>
            <tr><td style={{color:'var(--green)'}}>85–94</td><td>Strong — AI + 2+ rules + favourable macro</td></tr>
            <tr><td style={{color:'var(--green)'}}>95–100</td><td>Very strong — near-perfect alignment; rare</td></tr>
          </tbody>
        </table>
        <h4 className="edu-h4" style={{ marginTop: 16 }}>AI confidence band reference (20–90 ordinal scale)</h4>
        <table className="edu-table">
          <thead><tr><th>Raw score</th><th>Band</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td style={{color:'var(--red)'}}>20–35</td><td>very_low</td><td>Invalid, sparse, stale, or strongly contradictory data</td></tr>
            <tr><td style={{color:'var(--yellow)'}}>40–50</td><td>low</td><td>Weak or single-timeframe evidence; normally decision=none</td></tr>
            <tr><td>55–65</td><td>moderate</td><td>Usable setup with limited confirmation</td></tr>
            <tr><td style={{color:'var(--green)'}}>70–80</td><td>high</td><td>Two+ timeframes and two independent categories agree</td></tr>
            <tr><td style={{color:'var(--green)'}}>85–90</td><td>very_high</td><td>Broad, unusually clean agreement — use rarely</td></tr>
          </tbody>
        </table>
      </EduSection>

      {/* Section 6 — Backtesting */}
      <EduSection id="edu-backtesting" title="Backtesting — measuring signal quality" badge="Backtesting">
        <p className="section-desc">
          Backtesting replays the signal-detection pipeline over historical data so you
          can measure whether the system's signals have real edge — before risking any
          capital on them. Think of it as a practice exam: you already know the answers
          (the historical prices), so you can score the system honestly.
        </p>

        <h4 className="edu-sub-heading">What it does — a concrete example</h4>
        <p className="section-desc">
          The engine pretends it's the past. On each replayed day it assembles a market snapshot
          using only data available on that day (no peek into the future), runs the same rules
          used live, and records every signal. It then fast-forwards to see what actually happened.
        </p>
        <p className="section-desc">
          Suppose a signal fires on AAPL with <strong>entry $170, stop $167, target $176</strong>.
          Three outcomes are possible:
        </p>
        <ul className="edu-steps">
          <li>Price rises to <strong>$176</strong> within 10 days → <span style={{ color: 'var(--green)' }}>Win</span> (+$6/share)</li>
          <li>Price falls to <strong>$167</strong> within 10 days → <span style={{ color: 'var(--red)' }}>Loss</span> (−$3/share)</li>
          <li>Neither happens in 10 days → <strong>Timeout</strong> — exits at day-10 price (e.g. $172 = +$2/share)</li>
        </ul>

        <h4 className="edu-sub-heading">R-multiple — the universal measuring stick</h4>
        <p className="section-desc">
          Raw dollar gains are misleading. A $500 profit on a $500 bet is very different from
          a $500 profit on a $10,000 bet. Instead we express every trade as a multiple of the
          initial risk (entry − stop). We call this <strong>R</strong>.
        </p>
        <ul className="edu-steps">
          <li><strong>Formula (long):</strong> R = (exit − entry) / (entry − stop)</li>
          <li><strong>AAPL example:</strong> risk = $170 − $167 = <strong>$3</strong> (= 1R). Hitting target $176 → R = ($176−$170)/$3 = <strong>+2R</strong>. Stop hit → R = ($167−$170)/$3 = <strong>−1R</strong>.</li>
          <li><strong>Key insight:</strong> at a 2:1 bracket you only need to be right <strong>34 %</strong> of the time to break even — one +2R win cancels two −1R losses.</li>
        </ul>

        <h4 className="edu-sub-heading">Reading the metrics</h4>
        <ul className="edu-steps">
          <li><strong>Win rate</strong> — fraction of trades that hit target. 50 % is roughly random. With a 2:1 bracket, 40 % is already profitable (4×+2R + 6×−1R = +2R net).</li>
          <li><strong>Avg R-multiple</strong> — the average R across all trades. Any positive number means the system makes money in expectation. Above +0.3R is solid for a rules-based system.</li>
          <li><strong>Sharpe ratio</strong> — avg R ÷ standard deviation of R. Measures consistency. A Sharpe of 1.0 means the average win equals the variability — reliable, not lucky.</li>
          <li><strong>Max drawdown</strong> — the worst peak-to-trough fall in the cumulative-R curve. If you were up +8R and then fell to +3R, the drawdown is 5R. Ask: could you stomach that losing streak without quitting?</li>
          <li><strong>False-positive rate</strong> — fraction of signals that lost. Complement of win rate, calculated on floor-filtered trades only.</li>
        </ul>

        <h4 className="edu-sub-heading">Stop &amp; target: the ATR bracket</h4>
        <p className="section-desc">
          Rule-based signals give a direction and entry price but no stop or target. The engine
          builds a bracket from <strong>ATR (Average True Range)</strong> — how much the price
          typically moves per day over the last 14 days.
        </p>
        <ul className="edu-steps">
          <li><strong>ATR(14)</strong> = 14-day rolling average of the daily price range. If AAPL swings ~$3/day, ATR ≈ $3.</li>
          <li><strong>Stop (long)</strong> = entry − ATR_multiple × ATR. At the default 2.0× and ATR $3: stop = $170 − $6 = $164.</li>
          <li><strong>Target (long)</strong> = entry + R:R × |entry − stop|. At R:R 2.0: target = $170 + 2 × $6 = $182.</li>
        </ul>
        <p className="section-desc" style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>
          When live ATR is unavailable the engine estimates it from Bollinger Band width: <code>ATR ≈ (bb_upper − bb_lower) / 4</code>. If no band data exists either, the fallback is 2 % of current price.
        </p>

        <h4 className="edu-sub-heading">Choosing your ATR multiple</h4>
        <ul className="edu-steps">
          <li><strong>1.0×</strong> — tight stop ($3 away on AAPL). Cheaper losses but the trade gets shaken out by normal daily noise more often.</li>
          <li><strong>1.5×</strong> — narrower. Good for lower-volatility stocks where small moves are meaningful.</li>
          <li><strong>2.0× (default)</strong> — gives the trade two full ATR days of breathing room. Fewer premature exits, larger loss per stop. Recommended starting point.</li>
          <li>Use the <strong>Experiment Advisor</strong> to test other multiples on your data — look for the multiple that lifts avg-R without reducing trade count below ~20.</li>
        </ul>

        <h4 className="edu-sub-heading">Confidence-floor tuning</h4>
        <p className="section-desc">
          The engine records every signal regardless of confidence. After a run you can drag the
          floor slider and watch metrics recalculate instantly — no re-run needed.
          The sweep chart shows win-rate, avg-R, and trade count at every threshold from 0 to 100.
        </p>
        <p className="section-desc">
          <strong>Example:</strong> at floor 60 % you see 50 trades with 48 % win rate and avg R 0.3.
          At floor 75 %: 22 trades, 58 % win rate, avg R 0.8. At floor 90 %: 4 trades — too few to trust.
          The sweet spot here is 75 %: highest quality with a meaningful sample.
        </p>

        <h4 className="edu-sub-heading">Virtual wallet — seeing the dollars</h4>
        <p className="section-desc">
          R-metrics tell you the <em>edge</em>. The <strong>virtual wallet</strong> translates that
          into actual dollars so the results are tangible.
        </p>
        <ul className="edu-steps">
          <li><strong>How it works:</strong> set an initial balance (e.g. $10,000) and a position size (e.g. 10% = $1,000 per trade). Each signal invests exactly $1,000 — if the stop is 2 % away, you risk $20 on that trade.</li>
          <li><strong>Example:</strong> entry $170, stop $164 (risk $6, ATR 2.0×). Shares bought = $1,000 ÷ $170 ≈ 5.9. Win at $182: profit = 5.9 × $12 ≈ <strong>+$70</strong>. Loss at stop: loss = 5.9 × −$6 ≈ <strong>−$35</strong>.</li>
          <li><strong>$ equity curve</strong> (Section 6b in results) plots your running portfolio balance over the backtest window, with a buy-and-hold benchmark overlay so you can see at a glance whether the signals added value.</li>
          <li><strong>Wallet column</strong> in the Past Runs table shows final balance, total P&amp;L, and return % for every past experiment.</li>
        </ul>

        <h4 className="edu-sub-heading">Cashout rule — lock in gains before a reversal</h4>
        <p className="section-desc">
          Suppose a trade is going well — it reaches 1.8R unrealised profit — but then reverses and
          hits the stop at −1R. You watched a +1.8R winner turn into a −1R loss.
          The <strong>cashout rule</strong> exits a trade early the moment its unrealised R
          reaches a threshold you set.
        </p>
        <ul className="edu-steps">
          <li><strong>Example (cashout at 1.5R):</strong> entry $170, stop $164 (risk $6). Cashout price = $170 + 1.5 × $6 = $179. If price hits $179 on day 3, the trade closes with +1.5R — regardless of whether the original target ($182) is ever reached.</li>
          <li><strong>Without cashout:</strong> price reaches $179.50 on day 3, then falls back to stop $164 on day 5 → −1R. A +1.5R win became a −1R loss.</li>
          <li><strong>Trade-off:</strong> cashout costs you the upside between the cashout level and the full target on every winning trade. Only enable it if your runs show consistent "near-misses" on the equity curve (peak much higher than final balance).</li>
          <li>Cashout trades appear in <span style={{ color: 'var(--yellow)' }}>amber</span> in the trade list and are counted as wins in all metrics. The Past Runs table shows how many cashouts fired in each experiment.</li>
        </ul>

        <h4 className="edu-sub-heading">Saved configurations (profiles)</h4>
        <p className="section-desc">
          When you find a set of parameters that works well, give it a name and save it as a
          <strong> profile</strong>. You can load it in one click for future experiments on new
          tickers or date windows — no need to re-enter everything manually.
        </p>
        <ul className="edu-steps">
          <li>Click <strong>Save profile</strong> in the params section, type a name (e.g. "Aggressive swing 2R"), and save.</li>
          <li>Your profiles appear in a list. Click one to load all params. Saving with the same name overwrites the old version.</li>
          <li>Profiles are stored locally in your browser — they persist across sessions but are not synced to any server.</li>
        </ul>

        <h4 className="edu-sub-heading">Runs comparator</h4>
        <p className="section-desc">
          Select two or more past runs and click <strong>Compare</strong> to see them side by side.
          The comparator shows a table of all key metrics with the best value highlighted in green,
          and overlays their $ equity curves on a single chart. Use it to compare
          e.g. rules-only vs AI mode, or two different floor thresholds.
        </p>

        <h4 className="edu-sub-heading">Out-of-sample (OOS) validation</h4>
        <p className="section-desc">
          Tuning your parameters on a date window and then measuring performance on the <em>same</em>
          window is like memorising last year's exam answers — you'll score 100 % on the practice
          but fail the real exam. To get an honest estimate, you need a <em>held-out</em> window.
        </p>
        <ul className="edu-steps">
          <li><strong>Step 1 — Tune (OOS toggle OFF):</strong> run multiple experiments on your training window (e.g. Jan–Jun). Adjust floor, ATR multiple, R:R until metrics look solid.</li>
          <li><strong>Step 2 — Lock parameters:</strong> write them down (or save as a profile). Do not change them after this point.</li>
          <li><strong>Step 3 — Validate (OOS toggle ON):</strong> change the date window to a new period (e.g. Jul–Dec), flip the toggle, run once. <em>These</em> are your honest numbers.</li>
          <li><strong>AI Review uses it</strong> — OOS results get weighted more heavily and can elevate the deployment recommendation to "paper_trade" or "limited_live_candidate".</li>
        </ul>
        <p className="section-desc" style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>
          ⚠ Run the OOS validation <em>once</em>. Re-running it after adjusting params turns it back into in-sample data.
        </p>

        <h4 className="edu-sub-heading">Pitfalls to keep in mind</h4>
        <ul className="edu-steps">
          <li><strong>Overfitting</strong> — tuning the floor to a historical window and expecting the same results on new data. Always validate on a held-out OOS window.</li>
          <li><strong>Small samples</strong> — fewer than ~20 trades and the metrics are noise. Widen the date window or loosen the floor before drawing conclusions.</li>
          <li><strong>Daily-bar resolution</strong> — outcomes are evaluated on daily closing prices. If stop and target both fall inside one day's range, the stop wins (conservative tie-break).</li>
          <li><strong>Missing context</strong> — fundamentals and macro are not replayed, so those rules are disabled during replay to avoid leaking today's data backwards.</li>
          <li><strong>1H data limit</strong> — yfinance 1H data only goes back ~730 days; older windows fall back to daily-bar rules only.</li>
        </ul>
      </EduSection>

      {/* Section 7 — Paper Trading */}
      <EduSection id="edu-paper-trading" title="Paper trading with Alpaca" badge="Paper Trading">
        <p className="section-desc">
          Paper trading lets you simulate real trades without risking actual money. MarketSage
          connects to Alpaca's free paper-trading environment — every actionable signal
          can automatically place a bracket order (entry at market price, stop-loss, and
          take-profit attached) on a virtual $100 k account. The dedicated <strong>Trading</strong> tab
          in the top navigation shows the full paper-trading dashboard.
        </p>

        <h4 className="edu-sub-heading">How it works end-to-end</h4>
        <ol className="edu-steps">
          <li>
            <strong>Signal fires</strong> — the AI + rule engine marks an opportunity as
            actionable (confidence ≥ your floor). Each signal shows a <strong>🤖 LLM</strong> or <strong>📐 Rules</strong> badge
            indicating whether the AI contributed to it.
          </li>
          <li>
            <strong>Bracket order placed</strong> — MarketSage computes
            {' '}<code>qty = floor(position_size / entry_price)</code> whole shares, then POSTs to
            Alpaca with a stop-loss and take-profit leg. Stop and target prices are rounded to
            2 decimal places (Alpaca requirement). If the budget is too small for even 1 share
            the order is skipped.
          </li>
          <li>
            <strong>Order tracked</strong> — every scan, open orders are polled and their
            status (pending → filled → closed) is synced back to the local DB.
            Open the <strong>Trading</strong> tab to see the full orders table — click any row to
            expand per-order trade math (max loss, max gain, R:R ratio) and signal origin details.
          </li>
          <li>
            <strong>P&amp;L computed</strong> — Alpaca returns filled average price and
            realised P&amp;L. The Trading tab shows an area chart of cumulative P&amp;L
            over time with a 7D / 30D / 90D / All filter.
          </li>
        </ol>

        <h4 className="edu-sub-heading">Manual order placement</h4>
        <p className="section-desc">
          You don't have to wait for the scheduler. Every signal card on the Dashboard has a
          centred <strong>📈 Place Paper Order</strong> button. If an order already exists for
          that signal, the button is replaced by a disabled status badge (e.g. <em>PENDING NEW</em>).
          The Analysis Explorer also provides a Place button for every detected signal —
          including those below the confidence floor.
        </p>

        <h4 className="edu-sub-heading">Trading page charts</h4>
        <table className="edu-macro-table">
          <thead><tr><th>Chart</th><th>What it shows</th><th>When visible</th></tr></thead>
          <tbody>
            <tr><td>Orders by Status</td><td>Donut of pending / filled / cancelled counts</td><td>Any orders</td></tr>
            <tr><td>Max Gain / Max Loss</td><td>Green/red bars per order; cumulative total + net footer</td><td>Any orders with stop &amp; target</td></tr>
            <tr><td>Confidence per Order</td><td>Bar chart, colour-coded by band; dashed floor line</td><td>Any orders</td></tr>
            <tr><td>Realised P&amp;L</td><td>Cumulative area chart with 7D / 30D / 90D / All filter</td><td>Closed orders only</td></tr>
            <tr><td>P&amp;L by Ticker</td><td>Bar per ticker, green/red</td><td>Closed orders only</td></tr>
            <tr><td>Win / Loss</td><td>Donut + win rate %</td><td>Closed orders only</td></tr>
          </tbody>
        </table>

        <h4 className="edu-sub-heading">Settings</h4>
        <table className="edu-macro-table">
          <thead><tr><th>Setting</th><th>Default</th><th>What it controls</th></tr></thead>
          <tbody>
            <tr><td>Paper trading enabled</td><td>off</td><td>Master toggle — turns off auto order placement while keeping the data panel active</td></tr>
            <tr><td>Position size per trade</td><td>$500</td><td>Target $ per bracket order. Actual cost = <code>floor(size/price) × price</code></td></tr>
            <tr><td>Min confidence to trade</td><td>signal floor</td><td>Override the global confidence floor specifically for auto-trading</td></tr>
            <tr><td>Alpaca Paper API URL</td><td>https://paper-api.alpaca.markets/v2</td><td>Must include <code>/v2</code> — without it the account endpoint returns empty data</td></tr>
          </tbody>
        </table>

        <h4 className="edu-sub-heading">Getting started</h4>
        <ol className="edu-steps">
          <li>Create a free account at <strong>app.alpaca.markets</strong> and click <em>Paper Trading</em>.</li>
          <li>Copy your <strong>API Key ID</strong> and <strong>Secret Key</strong> from the Alpaca dashboard.</li>
          <li>Open <strong>Settings → Paper Trading</strong> in MarketSage, paste the keys, and click <em>Save &amp; Test Connection</em>. The account equity ($100 k) appears on success.</li>
          <li>Enable the <strong>Paper trading enabled</strong> toggle and set your position size.</li>
          <li>Wait for the next scheduled scan, trigger one manually, or click <strong>📈 Place Paper Order</strong> on any signal card — orders appear on the <strong>Trading</strong> page.</li>
        </ol>

        <div className="edu-callout">
          <strong>Free tier is sufficient.</strong> Alpaca's free paper-trading account gives
          full REST API access to both the trading API and the market data API (snapshots,
          VWAP, volume). No paid subscription is needed to use any feature in MarketSage.
          <br /><br />
          <strong>Whole shares only.</strong> Alpaca does not allow fractional shares on bracket
          orders. For high-priced stocks (e.g. a $958 stock with a $500 budget), the order is
          skipped rather than buying 1 share at nearly 2× the intended size. Increase your
          position size if you want to trade expensive stocks.
        </div>
      </EduSection>

      {/* Section 8 — Glossary with live search */}
      <GlossarySection />

      {/* Section 8 — Disclaimer + further reading */}
      <EduSection id="edu-further" title="Disclaimer & further reading" badge="⚠️">
        <div className="edu-disclaimer">
          <strong>⚠ Not financial advice.</strong> This system is for educational and research
          purposes only. It does not constitute financial, investment, or trading advice.
          All signals are generated by a local AI model and rule-based heuristics — they are
          not predictions and may be wrong. Markets are inherently risky. You are solely
          responsible for any decisions you make. Never trade money you cannot afford to lose.
        </div>

        <div className="edu-reading-grid">
          {/* Project wiki */}
          <div className="edu-reading-group">
            <div className="edu-reading-group-title">📖 Project wiki</div>
            <ul className="edu-links">
              <li>
                <a href="https://github.com/AlexandrosPlessias/offgrid-trader"
                   target="_blank" rel="noreferrer">
                  GitHub repository — source code & releases
                </a>
              </li>
              <li>
                <a href="https://github.com/AlexandrosPlessias/offgrid-trader/wiki/architecture"
                   target="_blank" rel="noreferrer">
                  Architecture — data pipeline, AI analysis, opportunity detection
                </a>
              </li>
              <li>
                <a href="https://github.com/AlexandrosPlessias/offgrid-trader/wiki/api"
                   target="_blank" rel="noreferrer">
                  API reference — all REST endpoints with request/response shapes
                </a>
              </li>
              <li>
                <a href="https://github.com/AlexandrosPlessias/offgrid-trader/wiki/observability"
                   target="_blank" rel="noreferrer">
                  Observability — Aspire setup, LLM spans, OTEL attribute reference
                </a>
              </li>
            </ul>
          </div>

          {/* Technical indicators */}
          <div className="edu-reading-group">
            <div className="edu-reading-group-title">📊 Technical indicators</div>
            <ul className="edu-links">
              <li>
                <a href="https://www.investopedia.com/terms/r/rsi.asp" target="_blank" rel="noreferrer">
                  Investopedia — RSI (Relative Strength Index)
                </a>
              </li>
              <li>
                <a href="https://www.investopedia.com/terms/m/macd.asp" target="_blank" rel="noreferrer">
                  Investopedia — MACD
                </a>
              </li>
              <li>
                <a href="https://www.investopedia.com/terms/e/ema.asp" target="_blank" rel="noreferrer">
                  Investopedia — Exponential Moving Average (EMA)
                </a>
              </li>
              <li>
                <a href="https://www.investopedia.com/terms/b/bollingerbands.asp" target="_blank" rel="noreferrer">
                  Investopedia — Bollinger Bands
                </a>
              </li>
              <li>
                <a href="https://www.investopedia.com/terms/s/stochasticoscillator.asp" target="_blank" rel="noreferrer">
                  Investopedia — Stochastic Oscillator
                </a>
              </li>
            </ul>
          </div>

          {/* Macro & valuation */}
          <div className="edu-reading-group">
            <div className="edu-reading-group-title">🌍 Macro &amp; valuation</div>
            <ul className="edu-links">
              <li>
                <a href="https://www.investopedia.com/terms/s/schillerpe.asp" target="_blank" rel="noreferrer">
                  Investopedia — Shiller P/E (CAPE)
                </a>
              </li>
              <li>
                <a href="https://www.investopedia.com/terms/y/yieldcurve.asp" target="_blank" rel="noreferrer">
                  Investopedia — Yield curve inversion
                </a>
              </li>
              <li>
                <a href="https://fred.stlouisfed.org" target="_blank" rel="noreferrer">
                  FRED — Federal Reserve Economic Data
                </a>
              </li>
              <li>
                <a href="https://www.multpl.com/shiller-pe" target="_blank" rel="noreferrer">
                  multpl.com — Shiller CAPE historical chart
                </a>
              </li>
            </ul>
          </div>
        </div>
      </EduSection>
      </div>
    </div>
  )
}
