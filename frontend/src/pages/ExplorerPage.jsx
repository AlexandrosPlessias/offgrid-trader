import { useState } from 'react'
import { useAnalyzeStream } from '../hooks/useAnalyzeStream'
import { API, getAuthHeaders } from '../utils/api'
import { fmtN, fmtTime, fmtMarketCap, fmtNewsDate } from '../utils/fmt'
import { INIT_STEPS } from '../components/analysis/AnalysisStepper'
import AnalysisStepper from '../components/analysis/AnalysisStepper'
import LLMReasoning from '../components/analysis/LLMReasoning'
import IndicatorTable from '../components/analysis/IndicatorTable'
import BalanceSheetChart from '../components/charts/BalanceSheetChart'
import MarketCharts from '../components/charts/MarketCharts'
import PriceHistoryChart from '../components/charts/PriceHistoryChart'
import AnalysisHistoryPanel from '../components/shared/AnalysisHistoryPanel'
import InfoTip from '../components/shared/InfoTip'

function macroStatus(key, value) {
  if (value == null) return { cls: '', interp: '' }
  switch (key) {
    case 'fed_funds_rate':
      if (value < 2)  return { cls: 'good', interp: 'Accommodative' }
      if (value < 5)  return { cls: 'warn', interp: 'Neutral' }
      return { cls: 'bad', interp: 'Restrictive' }
    case 'cpi_yoy':
      if (value < 2)  return { cls: 'good', interp: 'On target' }
      if (value < 5)  return { cls: 'warn', interp: 'Elevated' }
      return { cls: 'bad', interp: 'High inflation' }
    case 'unemployment':
      if (value < 4)  return { cls: 'good', interp: 'Strong labour' }
      if (value < 6)  return { cls: 'warn', interp: 'Near average' }
      return { cls: 'bad', interp: 'Weakening' }
    case 'yield_spread':
      return value > 0
        ? { cls: 'good', interp: 'Normal curve' }
        : { cls: 'bad',  interp: 'Inverted ⚠' }
    case 'shiller_cape':
      if (value < 20) return { cls: 'good', interp: 'Historically cheap' }
      if (value < 30) return { cls: 'warn', interp: 'Fair value' }
      return { cls: 'bad', interp: 'Elevated' }
    default:
      return { cls: '', interp: '' }
  }
}

export default function ExplorerPage({ initialResult, onBack, modelName, onOpenInExplorer }) {
  const [ticker, setTicker] = useState(initialResult?.ticker ?? '')
  const { streaming, steps, result: streamResult, error, run } = useAnalyzeStream()
  const [historyExpanded, setHistoryExpanded] = useState(false)
  // Section 7 place-order state — must live here, not inside the render IIFE
  const [sec7Orders, setSec7Orders] = useState({})

  // Use streamed result if available, otherwise show pre-loaded result from dashboard
  const result    = streamResult ?? initialResult
  const mkt       = result?.market_data
  const price     = mkt?.price
  const analysis    = result?.analysis
  const opps        = result?.opportunities ?? []
  const actionable  = result?.actionable ?? []
  const errors      = result?.errors ?? []
  const rulesChecked = result?.rules_checked ?? null  // always present even when no opps fire

  const handleRun = () => { run(ticker); setHistoryExpanded(false) }

  return (
    <div className="explorer-page">
      {/* Top bar */}
      <div className="explorer-topbar">
        <button className="btn-ghost" onClick={onBack}>← Dashboard</button>
        <span className="explorer-title">Analysis Explorer</span>
        <div className="analyze-row" style={{ flex: 1, maxWidth: 380 }}>
          <input
            className="ticker-input"
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleRun()}
            placeholder="Ticker (e.g. AAPL)"
            maxLength={10}
            disabled={streaming}
          />
          <button
            className="btn-primary"
            onClick={handleRun}
            disabled={streaming || !ticker.trim()}
          >
            {streaming ? 'Analyzing…' : 'Run Analysis'}
          </button>
        </div>
      </div>

      {/* Analysis History panel — collapsible, lives in Explorer */}
      <AnalysisHistoryPanel
        onOpenInExplorer={onOpenInExplorer}
        expanded={historyExpanded}
        onToggleExpanded={setHistoryExpanded}
      />

      {/* Empty state */}
      {result?._from_history && (
        <div className="history-banner">
          📋 Historical snapshot &nbsp;·&nbsp; {fmtTime(result._history_at)}
          &nbsp;—&nbsp; charts show live data, AI reasoning is from the saved run.
        </div>
      )}

      {!result && !streaming && !error && (
        <div className="explorer-empty">
          Enter a ticker above and click <strong>Run Analysis</strong> to begin the walkthrough.<br />
          <span style={{ fontSize: 12 }}>Or expand the Analysis History panel below to open a saved run.</span>
        </div>
      )}

      {error && <div className="error-msg" style={{ padding: '0 0 16px' }}>{error}</div>}

      {/* Section 1 — Pipeline stepper */}
      {(steps || result) && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">1</span>
            <span className="section-label">Pipeline walkthrough</span>
          </div>
          <p className="section-desc">
            Every analysis runs three steps: <strong>fetch</strong> live market data,{' '}
            <strong>analyze</strong> — the backend pre-computes candidate trade plans, then the
            configured LLM classifies the setup and selects a plan (entry/stop/target are
            backend-computed, not LLM-invented), then <strong>detect</strong> opportunities by
            combining the AI signal with rule-based checks (RSI extremes, MACD crossovers, volume
            spikes, valuation).
          </p>
          {steps
            ? <AnalysisStepper steps={steps} />
            : result && (
              <AnalysisStepper steps={INIT_STEPS.map(s =>
                s.id === 'analyze'
                  ? { ...s, status: 'done', llm_model: analysis?.llm_model ?? null, llm_provider: analysis?.llm_provider ?? null }
                  : { ...s, status: 'done' }
              )} />
            )
          }
        </div>
      )}

      {/* Section 2 — Price snapshot */}
      {price && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">2</span>
            <span className="section-label">Price snapshot</span>
          </div>
          <p className="section-desc">
            Current price, day change and volume ratio fetched from yfinance. Volume ratio
            above 1.5× average suggests unusual activity — either institutional interest or
            news-driven movement.
          </p>
          <div className="price-snapshot">
            <span className="snap-ticker">{result.ticker}</span>
            {mkt?.fundamentals?.name && mkt.fundamentals.name !== result.ticker && (
              <span className="snap-name">{mkt.fundamentals.name}</span>
            )}
            {price.current != null && (
              <span className="snap-price">${price.current.toFixed(2)}</span>
            )}
            {price.change_pct != null && (
              <span className={price.change_pct >= 0 ? 'snap-chg up' : 'snap-chg dn'}>
                {price.change_pct >= 0 ? '+' : ''}{price.change_pct.toFixed(2)}%
              </span>
            )}
            {price.volume_ratio != null && (
              <span className="snap-meta">Vol {price.volume_ratio.toFixed(1)}× avg</span>
            )}
            {price.day_high != null && price.day_low != null && (
              <span className="snap-meta">
                Day {price.day_low.toFixed(2)}–{price.day_high.toFixed(2)}
              </span>
            )}
            {price.week52_high != null && price.week52_low != null && (
              <span className="snap-meta">
                52w {price.week52_low.toFixed(2)}–{price.week52_high.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Fundamentals card — collapsible */}
      {mkt?.fundamentals && (
        <details className="explorer-section explorer-collapsible" open>
          <summary className="section-header">
            <span className="section-badge">Fundamentals</span>
            <span className="section-label">Company overview</span>
            <span className="section-chevron">›</span>
          </summary>
          <p className="section-desc">
            Key company data from yfinance. <strong>P/E (TTM)</strong> is trailing 12-month
            price-to-earnings; <strong>P/E (Fwd)</strong> is based on next-year consensus estimates.
            High P/E can mean growth expectations or overvaluation — context matters.
          </p>
          <div className="fundamentals-row">
            {mkt.fundamentals.sector && (
              <div className="fund-item">
                <span className="fund-label">Sector</span>
                <span className="fund-value">{mkt.fundamentals.sector}</span>
              </div>
            )}
            {mkt.fundamentals.industry && (
              <div className="fund-item">
                <span className="fund-label">Industry</span>
                <span className="fund-value">{mkt.fundamentals.industry}</span>
              </div>
            )}
            {mkt.fundamentals.market_cap != null && (
              <div className="fund-item">
                <span className="fund-label">Market Cap</span>
                <span className="fund-value">{fmtMarketCap(mkt.fundamentals.market_cap)}</span>
              </div>
            )}
            {(mkt.fundamentals.trailing_pe ?? mkt.fundamentals.pe_ratio) != null && (
              <div className="fund-item">
                <span className="fund-label">P/E (TTM)</span>
                <span className="fund-value">
                  {fmtN(mkt.fundamentals.trailing_pe ?? mkt.fundamentals.pe_ratio)}×
                </span>
              </div>
            )}
            {mkt.fundamentals.forward_pe != null && (
              <div className="fund-item">
                <span className="fund-label">P/E (Fwd)</span>
                <span className="fund-value">{fmtN(mkt.fundamentals.forward_pe)}×</span>
              </div>
            )}
          </div>
        </details>
      )}

      {/* Section 3 — Historical price chart (toggle-gated) */}
      {result && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">3</span>
            <span className="section-label">Historical chart</span>
          </div>
          <p className="section-desc">
            Price history gives context: is the current price near a multi-month high
            or recovering from a trough? Toggle on to load the last 3 months.
          </p>
          <PriceHistoryChart ticker={result.ticker} />
        </div>
      )}

      {/* Section 4 — Technical indicators */}
      {mkt && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">4</span>
            <span className="section-label">Technical indicators</span>
          </div>
          <p className="section-desc">
            Indicator snapshots across three timeframes (1H = short-term, 4H = medium-term,
            1D = long-term trend). The more timeframes agree, the stronger the signal.
          </p>
          <MarketCharts marketData={mkt} />
          <IndicatorTable marketData={mkt} />
        </div>
      )}

      {/* News card — collapsible */}
      {mkt && (
        <details className="explorer-section explorer-collapsible" open>
          <summary className="section-header">
            <span className="section-badge">News</span>
            <span className="section-label">Recent headlines</span>
            {(() => {
              const sent = mkt.news_sentiment
              if (!sent || sent.score == null) return null
              const { label, score } = sent
              const color = label === 'Bullish' ? 'var(--green)'
                          : label === 'Bearish' ? 'var(--red)'
                          : label === 'Mixed'   ? 'var(--yellow)'
                          : 'var(--dim)'
              const bg = label === 'Bullish' ? 'var(--long-bg)'
                       : label === 'Bearish' ? 'var(--short-bg)'
                       : 'var(--surface-2)'
              // confidence pts from the first opportunity's score_breakdown, if available
              const sentDelta = result?.opportunities?.[0]?.score_breakdown?.sentiment_delta ?? null
              return (
                <span className="rbadge" style={{ color, background: bg, marginLeft: 8, border: `1px solid ${color}33` }}>
                  {label} {score >= 0 ? '+' : ''}{score.toFixed(2)}
                  {sentDelta != null && (
                    <span style={{ opacity: 0.75, marginLeft: 4 }}>
                      ({sentDelta > 0 ? '+' : ''}{sentDelta} pts)
                    </span>
                  )}
                </span>
              )
            })()}
            <span className="section-chevron">›</span>
          </summary>
          <p className="section-desc">
            Last 7 days of company news from <strong>Google News RSS</strong> (always active)
            and <strong>Finnhub</strong> (optional, requires <code>FINNHUB_API_KEY</code>).
            Each headline is VADER-scored; the aggregate sentiment is included in the AI prompt.
          </p>
          {mkt.news?.length > 0 ? (
            <ul className="news-list">
              {mkt.news.map((item, i) => {
                const sc = item.sentiment_score
                const sentLabel = sc == null ? null
                  : sc > 0.15 ? 'Bullish'
                  : sc < -0.15 ? 'Bearish'
                  : sc > 0.05 ? 'Positive'
                  : sc < -0.05 ? 'Negative'
                  : 'Neutral'
                const sentColor = sc == null ? null
                  : sc > 0.05 ? 'var(--green)'
                  : sc < -0.05 ? 'var(--red)'
                  : 'var(--dim)'
                const sentBg = sc == null ? null
                  : sc > 0.05 ? 'var(--long-bg)'
                  : sc < -0.05 ? 'var(--short-bg)'
                  : 'var(--surface-2)'
                return (
                  <li key={i} className="news-item">
                    <a
                      className="news-headline"
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.headline}
                    </a>
                    <span className="news-meta">
                      {item.source && <span className="news-source">{item.source}</span>}
                      {item.channel && <span className="news-channel">{item.channel}</span>}
                      {sc != null && sentLabel && (
                        <span style={{
                          padding: '1px 6px', borderRadius: 4, fontSize: 11,
                          background: sentBg, color: sentColor,
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {sentLabel} {sc >= 0 ? '+' : ''}{sc.toFixed(2)}
                        </span>
                      )}
                      {item.datetime && <span>{fmtNewsDate(item.datetime)}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="text-dim" style={{ fontSize: 12 }}>
              No recent headlines found for this ticker.
            </div>
          )}
        </details>
      )}

      {/* Balance sheet card — collapsible, with bar chart */}
      {mkt?.balance_sheet && mkt.balance_sheet.period && (
        <details className="explorer-section explorer-collapsible" open>
          <summary className="section-header">
            <span className="section-badge">Balance Sheet</span>
            <span className="section-label">Financial health</span>
            <span className="section-chevron">›</span>
          </summary>
          <p className="section-desc">
            Most recent annual balance sheet from yfinance (period: <strong>{mkt.balance_sheet.period}</strong>).
            Debt-to-equity above 2× warrants extra caution; negative equity indicates liabilities
            exceed assets. The AI model sees this data in its prompt.
          </p>
          <BalanceSheetChart bs={mkt.balance_sheet} />
          <details className="indicator-details" style={{ marginTop: 8 }}>
            <summary>📊 Full balance sheet</summary>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <tbody>
                  {[
                    { label: 'Total Assets',         val: mkt.balance_sheet.total_assets },
                    { label: 'Total Liabilities',    val: mkt.balance_sheet.total_liabilities },
                    { label: 'Stockholders Equity',  val: mkt.balance_sheet.stockholders_equity },
                    { label: 'Total Debt',           val: mkt.balance_sheet.total_debt },
                    { label: 'Cash & Equivalents',   val: mkt.balance_sheet.cash },
                    { label: 'Debt / Equity',        val: mkt.balance_sheet.debt_to_equity, raw: true },
                  ].map(({ label, val, raw }) => (
                    <tr key={label}>
                      <td className="text-dim">{label}</td>
                      <td>
                        {val == null ? '—' : raw ? `${fmtN(val)}×` : fmtMarketCap(val)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </details>
      )}

      {/* Macro context card — collapsible, status dots, interpretation labels */}
      {mkt?.macro && Object.keys(mkt.macro).filter(k => !k.startsWith('_')).length > 0 && (
        <details className="explorer-section explorer-collapsible" open>
          <summary className="section-header">
            <span className="section-badge">Macro</span>
            <span className="section-label">
              US macro context{' '}
              <InfoTip text="Macro data from FRED (key-free CSV) and multpl.com. Data lags by days–weeks. Included in the AI prompt so the model can reason about the broader economic environment." />
            </span>
            <span className="section-chevron">›</span>
          </summary>
          <p className="section-desc">
            Federal Reserve rate, inflation, unemployment and yield curve from FRED; Shiller CAPE
            (P/E 10) from multpl.com. Cached for 6 hours and shared across all tickers in a scan.
          </p>
          {/* Fetch-failure banner — shown when all values are null */}
          {['fed_funds_rate','cpi_yoy','unemployment','yield_spread','shiller_cape']
            .every(k => mkt.macro[k]?.value == null) && (
            <div className="macro-fetch-error">
              ⚠ Could not fetch macro data — the Docker container may not have outbound internet
              access to <code>fred.stlouisfed.org</code> / <code>multpl.com</code>.
              {mkt?.errors?.some(e => e.startsWith('macro:')) && (
                <span style={{ display: 'block', marginTop: 4, color: '#92400e' }}>
                  {mkt.errors.filter(e => e.startsWith('macro:')).join(' · ')}
                </span>
              )}
            </div>
          )}
          <div className="macro-grid">
            {[
              { key: 'fed_funds_rate', label: 'Fed Funds Rate', unit: '%' },
              { key: 'cpi_yoy',        label: 'CPI YoY',        unit: '%' },
              { key: 'unemployment',   label: 'Unemployment',   unit: '%' },
              { key: 'yield_spread',   label: '10y-2y Spread',  unit: '%', isSpread: true },
              { key: 'shiller_cape',   label: 'Shiller CAPE',   unit: '×' },
            ].map(({ key, label, unit, isSpread }) => {
              const metric   = mkt.macro[key]
              const inverted = isSpread && metric?.inverted
              const { cls, interp } = macroStatus(key, metric?.value ?? null)
              return (
                <div key={key} className={`macro-item${inverted ? ' macro-inverted' : ''}`}>
                  <span className="macro-label">
                    {cls && <span className={`macro-status macro-status-${cls}`} />}
                    {label}
                  </span>
                  <span className="macro-value">
                    {metric?.value != null ? `${fmtN(metric.value)}${unit}` : '—'}
                    {inverted && <span className="macro-warn"> ⚠ inverted</span>}
                  </span>
                  {interp && <span className="macro-interp">{interp}</span>}
                  {metric?.date && <span className="macro-date">as of {metric.date}</span>}
                </div>
              )
            })}
          </div>
        </details>
      )}

      {/* Section 5 — AI reasoning */}
      {analysis && (() => {
        // Prefer per-analysis model info (recorded at run time) over the
        // global default model from /health — shows what actually ran.
        const perAnalysisModel    = analysis.llm_model    || null
        const perAnalysisProvider = analysis.llm_provider || null
        const displayModel        = perAnalysisModel    || modelName
        const displayProvider     = perAnalysisProvider || null
        const llmDisabled         = !!analysis.error || !perAnalysisProvider
        return (
          <div className="explorer-section" style={{ position: 'relative' }}>
            <div className="section-header">
              <span className="section-badge">5</span>
              <span className="section-label">
                AI reasoning
                {displayModel && (
                  <span
                    className="model-chip"
                    title={
                      displayProvider
                        ? `Analyzed with ${displayProvider} · ${displayModel}`
                        : `Model: ${displayModel}`
                    }
                  >
                    {displayProvider ? `${displayProvider} · ` : ''}{displayModel}
                  </span>
                )}
              </span>
            </div>
            <p className="section-desc">
              The AI model receives all indicator data as a structured prompt and
              returns a JSON analysis: trend direction, momentum, key price levels, supporting
              signals and risk factors.{' '}
              {(!perAnalysisProvider || perAnalysisProvider === 'ollama')
                ? 'Runs entirely on your machine — no cloud API calls.'
                : `Running via ${perAnalysisProvider} cloud inference.`
              }
            </p>
            <LLMReasoning analysis={analysis} defaultOpen={!llmDisabled} />
            {llmDisabled && (
              <div style={{
                position: 'absolute', inset: 0, borderRadius: 8, zIndex: 2,
                backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)',
                background: 'rgba(10,15,10,0.55)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}>
                <span style={{ fontSize: 22 }}>🤖</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#aaa' }}>LLM not applied</span>
                <span style={{ fontSize: 11, color: '#666', textAlign: 'center', maxWidth: 260 }}>
                  AI reasoning is disabled — enable a provider in <strong>Settings → AI Provider</strong> to activate this section.
                </span>
              </div>
            )}
          </div>
        )
      })()}

      {/* Section 6 — Opportunity score computation (always visible) */}
      {result && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">6</span>
            <span className="section-label">Opportunity score computation</span>
          </div>
          <p className="section-desc">
            Each score is built step by step: individual rule confidences are merged
            (max source + 5 pt corroboration bonus per additional agreeing source), then
            adjusted ±pts by the macro regime filter (yield curve, Shiller CAPE, CPI).
          </p>
          {opps.length === 0 && (
            <div className="score-comp-empty">
              <p className="score-comp-empty-title">No rule checks fired this scan</p>
              <p className="score-comp-empty-sub">All 5 rules ran and found no signal — thresholds not met.</p>
              {rulesChecked ? (() => {
                const rc = rulesChecked
                const RULES = [
                  {
                    key: 'ai', label: 'AI model', fired: rc.ai?.fired,
                    value: rc.ai?.type == null ? '—'
                      : analysis?.confidence_band
                        ? `${rc.ai.type} · conf ${rc.ai.confidence ?? '?'} (${(analysis.confidence_band||'').replace(/_/g,' ')})`
                        : `type: ${rc.ai.type} | conf: ${rc.ai.confidence ?? '?'}`,
                    rule: rc.ai?.type == null ? 'no analysis run'
                      : rc.ai?.type === 'none'
                        ? `AI found no clear setup${analysis?.reason_code ? ' — ' + analysis.reason_code.replace(/_/g,' ') : ''}`
                        : rc.ai?.fired ? 'above confidence floor → fired' : 'below confidence floor → not fired',
                  },
                  {
                    key: 'rsi', label: 'RSI extreme', fired: rc.rsi_extreme?.fired,
                    value: (() => {
                      const vals = rc.rsi_extreme?.values ?? {}
                      return Object.entries(vals).filter(([,v]) => v != null)
                        .map(([tf,v]) => `${tf}: ${v}`).join(' | ') || '—'
                    })(),
                    rule: (() => {
                      const lo = rc.rsi_extreme?.threshold_low ?? 30
                      const hi = rc.rsi_extreme?.threshold_high ?? 70
                      if (rc.rsi_extreme?.fired) return `<${lo} or >${hi} on 2+ TFs → fired`
                      const n = (rc.rsi_extreme?.oversold?.length ?? 0) + (rc.rsi_extreme?.overbought?.length ?? 0)
                      return `need <${lo} or >${hi} on 2+ TFs${n === 1 ? ' — only 1 TF triggered' : ''}`
                    })(),
                  },
                  {
                    key: 'vol', label: 'Volume spike', fired: rc.volume_spike?.fired,
                    value: (() => {
                      const r = rc.volume_spike?.ratio, c = rc.volume_spike?.change_pct
                      if (r == null) return 'no data'
                      return `ratio ${r.toFixed(1)}× | move ${c != null ? (c > 0 ? '+' : '') + c.toFixed(1) : '?'}%`
                    })(),
                    rule: (() => {
                      const tr = rc.volume_spike?.threshold_ratio ?? 2, tm = rc.volume_spike?.threshold_move ?? 2
                      return rc.volume_spike?.fired ? `≥${tr}× AND ≥${tm}% → fired` : `need ratio ≥${tr}× AND move ≥${tm}%`
                    })(),
                  },
                  {
                    key: 'macd', label: 'MACD crossover', fired: rc.macd_crossover?.fired,
                    value: (() => {
                      const h1 = rc.macd_crossover?.hist_1d, h4 = rc.macd_crossover?.hist_4h
                      if (h1 == null || h4 == null) return 'no data'
                      return `hist 1D: ${h1 > 0 ? '+' : ''}${h1.toFixed(3)} | 4H: ${h4 > 0 ? '+' : ''}${h4.toFixed(3)}`
                    })(),
                    rule: rc.macd_crossover?.fired ? 'both TFs same-sign → fired' : 'need both TFs same-sign histogram',
                  },
                  {
                    key: 'val', label: 'Valuation P/E', fired: rc.valuation?.fired,
                    value: rc.valuation?.pe == null ? 'P/E n/a' : `P/E ${rc.valuation.pe}×`,
                    rule: (() => {
                      const lo = rc.valuation?.threshold_low ?? 8, hi = rc.valuation?.threshold_high ?? 60
                      return rc.valuation?.fired ? `<${lo} or >${hi} → fired` : `P/E in normal range (${lo}–${hi}×)`
                    })(),
                  },
                ]
                return (
                  <div className="rule-checks" style={{marginTop:'10px'}}>
                    {RULES.map(r => (
                      <div key={r.key} className={`rule-check ${r.fired ? 'fired' : 'miss'}`}>
                        <span className="rule-check-icon">{r.fired ? '✓' : '✗'}</span>
                        <span className="rule-check-name">{r.label}</span>
                        <span className="rule-check-val">{r.value}</span>
                        <span className="rule-check-rule">{r.rule}</span>
                      </div>
                    ))}
                  </div>
                )
              })() : (
                <div className="rule-checks" style={{marginTop:'10px'}}>
                  {[
                    { label: 'AI model',       note: 'type: none or confidence below floor' },
                    { label: 'RSI extreme',    note: 'no timeframe below 30 or above 70' },
                    { label: 'Volume spike',   note: 'ratio <2× or price move <2%' },
                    { label: 'MACD crossover', note: '1D and 4H histograms disagree or flat' },
                    { label: 'Valuation P/E',  note: 'P/E in normal range (8–60×)' },
                  ].map(r => (
                    <div key={r.label} className="rule-check miss">
                      <span className="rule-check-icon">✗</span>
                      <span className="rule-check-name">{r.label}</span>
                      <span className="rule-check-val" style={{opacity:0.45}}>—</span>
                      <span className="rule-check-rule">{r.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="score-comp-list">
            {[...opps]
              .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
              .map((opp, i) => {
                const isActionable = actionable.some(
                  a => a.type === opp.type && Math.abs((a.confidence ?? 0) - (opp.confidence ?? 0)) < 0.5
                )
                const bd = opp.score_breakdown
                const hasBonus     = bd && (bd.bonus ?? 0) > 0
                const hasMacro     = bd && (bd.macro_delta ?? 0) !== 0
                const hasSentiment = bd && (bd.sentiment_delta ?? 0) !== 0
                return (
                  <div key={i} className={`score-comp-card ${isActionable ? 'score-comp-ok' : 'score-comp-sub'}`}>
                    <div className="score-comp-header">
                      <span className={`badge ${opp.type}`}>{opp.type?.toUpperCase() ?? '—'}</span>
                      <span className="score-comp-final">{(opp.confidence ?? 0).toFixed(0)}%</span>
                      <span className="score-comp-src">{opp.source ?? (opp.sources ?? []).join('+') ?? ''}</span>
                      {isActionable
                        ? <span className="score-comp-status ok">✓ actionable</span>
                        : <span className="score-comp-status sub">↓ below floor</span>
                      }
                    </div>
                    {bd && (
                      <div className="score-comp-body">
                        <div className="score-comp-row">
                          <span className="score-comp-label">Sources</span>
                          <div>
                            <div className="score-comp-sources">
                              {(bd.sources_detail ?? []).map(s => (
                                <span key={s.source} className="opp-bd-src-item">
                                  <span className="opp-bd-src-name">{s.source.replace(/_/g, ' ')}</span>
                                  <span className="opp-bd-src-conf">{(s.confidence ?? 0).toFixed(0)}</span>
                                </span>
                              ))}
                            </div>
                            {(bd.sources_detail ?? []).length === 1 && (
                              <div className="score-comp-hint">
                                1 of 5 rules fired — direction <strong>{opp.type?.toUpperCase()}</strong> set by this rule alone. Other 4 rules found no signal (conditions not met).
                              </div>
                            )}
                            {(bd.sources_detail ?? []).length > 1 && (
                              <div className="score-comp-hint">
                                {(bd.sources_detail ?? []).length} of 5 rules fired, all agree on{' '}
                                <strong>{opp.type?.toUpperCase()}</strong> direction → corroboration bonus applied.
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="score-comp-row">
                          <span className="score-comp-label">Formula</span>
                          <div className="score-comp-formula">
                            {/* Step 1: best single source */}
                            <span className="score-comp-step">
                              best source <strong>{(bd.base ?? 0).toFixed(0)}</strong>
                            </span>
                            {/* Step 2: corroboration bonus (only when > 1 source) */}
                            {hasBonus ? (
                              <>
                                <span className="score-comp-op">+</span>
                                <span className="score-comp-step bonus">
                                  {(bd.bonus ?? 0).toFixed(0)} bonus
                                  <span className="score-comp-note">({(bd.sources_detail ?? []).length - 1} extra × 5)</span>
                                </span>
                                <span className="score-comp-op">→</span>
                                <span className="score-comp-step">{(bd.pre_macro ?? 0).toFixed(0)} pre-macro</span>
                              </>
                            ) : (
                              <>
                                <span className="score-comp-op score-comp-op-dim">(no bonus — 1 rule)</span>
                                <span className="score-comp-op">→</span>
                                <span className="score-comp-step">{(bd.pre_macro ?? 0).toFixed(0)} pre-macro</span>
                              </>
                            )}
                            {/* Step 3: macro regime adjustment */}
                            {hasMacro ? (
                              <>
                                <span className={`score-comp-step macro ${(bd.macro_delta ?? 0) < 0 ? 'neg' : 'pos'}`}>
                                  {(bd.macro_delta ?? 0) > 0 ? '+' : ''}{(bd.macro_delta ?? 0).toFixed(0)} macro
                                </span>
                                <span className="score-comp-op">→</span>
                              </>
                            ) : (
                              <span className="score-comp-op score-comp-op-dim">(no macro adj)</span>
                            )}
                            {/* Step 4: news sentiment adjustment */}
                            {hasSentiment ? (
                              <>
                                <span className={`score-comp-step macro ${(bd.sentiment_delta ?? 0) < 0 ? 'neg' : 'pos'}`}>
                                  {(bd.sentiment_delta ?? 0) > 0 ? '+' : ''}{(bd.sentiment_delta ?? 0).toFixed(0)} sentiment
                                </span>
                                <span className="score-comp-op">→</span>
                              </>
                            ) : (
                              <span className="score-comp-op score-comp-op-dim">(no sentiment adj)</span>
                            )}
                            {/* Step 5: final */}
                            <span className="score-comp-step final">
                              <strong>{(bd.final ?? opp.confidence ?? 0).toFixed(0)}</strong> final
                            </span>
                          </div>
                        </div>
                        {/* All-rules diagnostic — shows actual values even for rules that didn't fire */}
                        {bd.rules_checked && (() => {
                          const rc = bd.rules_checked
                          const RULES = [
                            {
                              key: 'ai',
                              label: 'AI model',
                              fired: rc.ai?.fired,
                              value: rc.ai?.type == null
                                ? '—'
                                : analysis?.confidence_band
                                  ? `${rc.ai.type} · conf ${rc.ai.confidence ?? '?'} (${(analysis.confidence_band || '').replace(/_/g,' ')})`
                                  : `type: ${rc.ai.type} | conf: ${rc.ai.confidence ?? '?'}`,
                              rule: rc.ai?.type == null
                                ? 'no analysis run'
                                : rc.ai?.type === 'none'
                                  ? `AI found no clear setup${analysis?.reason_code ? ' — ' + analysis.reason_code.replace(/_/g,' ') : ''}`
                                  : rc.ai?.fired
                                    ? 'above confidence floor → fired'
                                    : 'below confidence floor → not fired',
                            },
                            {
                              key: 'rsi',
                              label: 'RSI extreme',
                              fired: rc.rsi_extreme?.fired,
                              value: (() => {
                                const vals = rc.rsi_extreme?.values ?? {}
                                return Object.entries(vals)
                                  .filter(([, v]) => v != null)
                                  .map(([tf, v]) => `${tf}: ${v}`)
                                  .join(' | ') || '—'
                              })(),
                              rule: (() => {
                                const lo = rc.rsi_extreme?.threshold_low ?? 30
                                const hi = rc.rsi_extreme?.threshold_high ?? 70
                                if (rc.rsi_extreme?.fired) return `<${lo} or >${hi} on 2+ TFs → fired`
                                const os = rc.rsi_extreme?.oversold ?? []
                                const ob = rc.rsi_extreme?.overbought ?? []
                                const n = os.length + ob.length
                                return `need <${lo} (oversold) or >${hi} (overbought) on 2+ TFs${n === 1 ? ` — only ${[...os, ...ob][0]} triggered` : ''}`
                              })(),
                            },
                            {
                              key: 'vol',
                              label: 'volume spike',
                              fired: rc.volume_spike?.fired,
                              value: (() => {
                                const r = rc.volume_spike?.ratio
                                const c = rc.volume_spike?.change_pct
                                if (r == null) return 'no data'
                                return `ratio ${r.toFixed(1)}× | move ${c != null ? (c > 0 ? '+' : '') + c.toFixed(1) : '?'}%`
                              })(),
                              rule: (() => {
                                const tr = rc.volume_spike?.threshold_ratio ?? 2
                                const tm = rc.volume_spike?.threshold_move ?? 2
                                if (rc.volume_spike?.fired) return `ratio ≥${tr}× AND move ≥${tm}% → fired`
                                return `need ratio ≥${tr}× AND price move ≥${tm}%`
                              })(),
                            },
                            {
                              key: 'macd',
                              label: 'MACD crossover',
                              fired: rc.macd_crossover?.fired,
                              value: (() => {
                                const h1 = rc.macd_crossover?.hist_1d
                                const h4 = rc.macd_crossover?.hist_4h
                                if (h1 == null || h4 == null) return 'no data'
                                return `hist 1D: ${h1 > 0 ? '+' : ''}${h1.toFixed(3)} | 4H: ${h4 > 0 ? '+' : ''}${h4.toFixed(3)}`
                              })(),
                              rule: rc.macd_crossover?.fired
                                ? 'both TFs same-sign histogram → fired'
                                : 'need both TFs same-sign (both + or both −)',
                            },
                            {
                              key: 'val',
                              label: 'valuation P/E',
                              fired: rc.valuation?.fired,
                              value: (() => {
                                const pe = rc.valuation?.pe
                                return pe == null ? 'P/E n/a' : `P/E ${pe}×`
                              })(),
                              rule: (() => {
                                const lo = rc.valuation?.threshold_low ?? 8
                                const hi = rc.valuation?.threshold_high ?? 60
                                if (rc.valuation?.fired) return `<${lo} (cheap) or >${hi} (expensive) → fired`
                                return `extreme: <${lo} undervalued or >${hi} overvalued`
                              })(),
                            },
                            {
                              key: 'sentiment',
                              label: 'news sentiment',
                              fired: rc.sentiment?.applied && (rc.sentiment?.score ?? 0) !== 0
                                && !['Neutral', 'Mixed'].includes(rc.sentiment?.label ?? ''),
                              value: (() => {
                                const s = rc.sentiment
                                if (!s?.applied || s.score == null) return 'no data'
                                return `${s.label ?? 'Neutral'} ${s.score >= 0 ? '+' : ''}${s.score.toFixed(3)} (${s.article_count ?? 0} articles)`
                              })(),
                              rule: (() => {
                                const s = rc.sentiment
                                if (!s?.applied) return 'no news data available'
                                const delta = bd?.sentiment_delta ?? 0
                                if (delta === 0) return `${s.label ?? 'Neutral'} — no confidence adjustment`
                                return `${s.label} → ${delta > 0 ? '+' : ''}${delta} pts confidence`
                              })(),
                            },
                          ]
                          return (
                            <div className="score-comp-row">
                              <span className="score-comp-label">All rules</span>
                              <div className="rule-checks">
                                {RULES.map(rule => (
                                  <div key={rule.key} className={`rule-check ${rule.fired ? 'fired' : 'miss'}`}>
                                    <span className="rule-check-icon">{rule.fired ? '✓' : '✗'}</span>
                                    <span className="rule-check-name">{rule.label}</span>
                                    <span className="rule-check-val">{rule.value}</span>
                                    <span className="rule-check-rule">{rule.rule}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })()}

                        {/* v2: LLM signal metrics — evidence + risks from the AI model */}
                        {analysis?.schema_version && (analysis?.evidence?.length > 0 || analysis?.risks?.length > 0) && (
                          <div className="score-comp-row">
                            <span className="score-comp-label">LLM metrics</span>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {analysis.data_quality?.grade && (
                                <div style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 2 }}>
                                  Data quality: <strong style={{
                                    color: analysis.data_quality.grade === 'good' ? 'var(--green)'
                                      : analysis.data_quality.grade === 'poor' ? 'var(--red)' : 'var(--text)',
                                  }}>{analysis.data_quality.grade}</strong>
                                  {analysis.data_quality.warnings?.length > 0 && (
                                    <span style={{ marginLeft: 8 }}>⚠ {analysis.data_quality.warnings.join('; ')}</span>
                                  )}
                                </div>
                              )}
                              {(analysis.evidence ?? []).length > 0 && (
                                <div>
                                  <div className="score-comp-hint" style={{ marginBottom: 4 }}>AI evidence (direction · strength → observation)</div>
                                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    {analysis.evidence.map((e, j) => (
                                      <li key={j} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                        <span style={{ minWidth: 52, fontSize: 10, fontWeight: 700, paddingTop: 1,
                                          color: EVIDENCE_DIR_COLOR[e.direction] || 'var(--dim)' }}>
                                          {(e.direction||'').toUpperCase()}
                                        </span>
                                        <span style={{ minWidth: 50, fontSize: 10, color: 'var(--dim)', paddingTop: 1 }}>
                                          {e.strength}
                                        </span>
                                        <span>{e.observation}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {(analysis.risks ?? []).length > 0 && (
                                <div>
                                  <div className="score-comp-hint" style={{ marginBottom: 4 }}>AI risk factors (severity → observation)</div>
                                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    {analysis.risks.map((r, j) => (
                                      <li key={j} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                        <span style={{ minWidth: 52, fontSize: 10, fontWeight: 700, paddingTop: 1,
                                          color: RISK_SEV_COLOR[r.severity] || 'var(--dim)' }}>
                                          {(r.severity||'').toUpperCase()}
                                        </span>
                                        <span>{r.observation}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {analysis.summary && (
                                <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic', margin: 0 }}>
                                  → {analysis.summary}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                        {/* Legacy v1 reasons */}
                        {!analysis?.schema_version && opp.reasons && opp.reasons.length > 0 && (
                          <div className="score-comp-row">
                            <span className="score-comp-label">Evidence</span>
                            <div>
                              <div className="score-comp-hint" style={{marginBottom:'6px'}}>
                                Raw indicator values and pass/fail thresholds are shown in All Rules above.
                              </div>
                              <ul className="score-comp-reasons">
                                {opp.reasons.map((r, j) => <li key={j}>{r}</li>)}
                              </ul>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            }
          </div>
        </div>
      )}

      {/* Section 7 — Detected opportunities */}
      {result && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">7</span>
            <span className="section-label">Signals detected</span>
          </div>
          <p className="section-desc">
            Five rule-based checks run in parallel (RSI extreme, MACD crossover, volume spike,
            valuation extreme, AI signal). Candidates for the same ticker are merged and their
            confidence scores are adjusted by a macro regime filter (yield curve, Shiller CAPE,
            CPI). Only signals at or above the confidence floor are marked actionable and trigger alerts.
          </p>
          {errors.length > 0 && (
            <div className="error-list">{errors.map((e, i) => <div key={i}>⚠ {e}</div>)}</div>
          )}
          {opps.length === 0 ? (
            <div>
              <div className="text-dim" style={{ marginBottom: 10 }}>
                No signals detected — no rule checks fired for this ticker.
              </div>

              {/* AI score summary + pointer to Section 5 & 6 for full detail */}
              {analysis && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  padding: '8px 12px', background: 'var(--surface-2)',
                  border: '1px solid var(--border)', borderRadius: 6,
                }}>
                  <span style={{ fontSize: 12, color: 'var(--dim)' }}>AI score:</span>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>
                    {analysis.confidence_raw ?? analysis.opportunity?.confidence ?? '—'}
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--dim)', marginLeft: 4 }}>/90</span>
                  </span>
                  {analysis.confidence_band && (
                    <span style={{
                      fontSize: 11, padding: '2px 7px', borderRadius: 99, fontWeight: 600,
                      color: CONF_BAND_COLOR[analysis.confidence_band] || 'var(--dim)',
                      background: (CONF_BAND_COLOR[analysis.confidence_band] || 'var(--dim)') + '22',
                    }}>
                      {analysis.confidence_band.replace(/_/g, ' ')}
                    </span>
                  )}
                  {analysis.reason_code && (
                    <span style={{ fontSize: 11, color: 'var(--dim)' }}>
                      {analysis.reason_code.replace(/_/g, ' ')}
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto', fontStyle: 'italic' }}>
                    ↑ Section 5 for AI reasoning · Section 6 for rule-check values
                  </span>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="signals-summary">
                {actionable.length > 0
                  ? <><span className="signals-ok">✓ {actionable.length} actionable</span>
                      {opps.length - actionable.length > 0 && (
                        <span className="signals-subfloor"> · {opps.length - actionable.length} below floor</span>
                      )}
                    </>
                  : <span className="signals-subfloor">All {opps.length} signal(s) below confidence floor</span>
                }
              </div>
              {(() => {
                const placeFromSec7 = async (opp, idx) => {
                  setSec7Orders(s => ({ ...s, [idx]: 'placing' }))
                  try {
                    const res = await fetch(`${API}/paper/orders/place`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                      body: JSON.stringify({
                        ticker:            result.ticker,
                        side:              opp.type === 'long' ? 'buy' : 'sell',
                        entry:             opp.entry ?? opp.price,
                        stop:              opp.stop,
                        target:            opp.target,
                        signal_confidence: opp.confidence ?? null,
                        signal_source:     opp.source ?? (opp.sources ? opp.sources.join('+') : null),
                        signal_timestamp:  opp.timestamp ?? null,
                      }),
                    })
                    const data = await res.json()
                    if (!res.ok) setSec7Orders(s => ({ ...s, [idx]: data.detail ?? 'Error' }))
                    else setSec7Orders(s => ({ ...s, [idx]: data.placed ? 'placed' : 'exists' }))
                  } catch { setSec7Orders(s => ({ ...s, [idx]: 'Error' })) }
                }
                const sorted = [...opps].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
                return (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Direction</th><th>Mode</th><th>Confidence</th><th>Price</th>
                          <th>Entry</th><th>Stop</th><th>Target</th><th>Source</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((opp, i) => {
                          const isActionable = actionable.some(
                            a => a.type === opp.type && Math.abs((a.confidence ?? 0) - (opp.confidence ?? 0)) < 0.5
                          )
                          const os = sec7Orders[i]
                          const canPlace = opp.stop != null && opp.target != null
                          const srcList = opp.sources ?? (opp.source ? opp.source.split('+') : [])
                          const hasLlm  = srcList.some(s => s.trim() === 'ai')
                                       || (opp.score_breakdown?.rules_checked?.ai?.fired === true)
                          return (
                            <tr key={i} className={isActionable ? '' : 'row-subfloor'}>
                              <td>
                                <span className={`badge ${opp.type}`}>
                                  {opp.type === 'long' ? '▲' : opp.type === 'short' ? '▼' : ''} {opp.type?.toUpperCase() ?? '—'}
                                </span>
                              </td>
                              <td>
                                <span
                                  title={hasLlm ? 'Signal includes AI/LLM contribution' : 'Signal from rule-based engine only (no LLM)'}
                                  style={{
                                    fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
                                    textTransform: 'uppercase', padding: '2px 5px', borderRadius: 4,
                                    background: hasLlm
                                      ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                                      : 'color-mix(in srgb, var(--dim) 10%, transparent)',
                                    color: hasLlm ? 'var(--accent)' : 'var(--dim)',
                                    border: `1px solid ${hasLlm ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--dim) 20%, transparent)'}`,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {hasLlm ? '🤖 LLM' : '📐 Rules'}
                                </span>
                              </td>
                              <td>
                                <span className={isActionable ? 'conf-value conf-ok' : 'conf-value conf-sub'}>
                                  {(opp.confidence ?? 0).toFixed(0)}%
                                </span>
                                {!isActionable && <span className="subfloor-tag">below floor</span>}
                              </td>
                              <td>{opp.price?.toFixed(2) ?? '—'}</td>
                              <td>{opp.entry?.toFixed(2) ?? '—'}</td>
                              <td>{opp.stop?.toFixed(2) ?? '—'}</td>
                              <td>{opp.target?.toFixed(2) ?? '—'}</td>
                              <td className="text-dim source-cell">
                                {opp.source ?? (opp.sources ?? []).join('+') ?? '—'}
                              </td>
                              <td>
                                {canPlace && os !== 'placed' && os !== 'exists' && (
                                  <button
                                    onClick={() => placeFromSec7(opp, i)}
                                    disabled={os === 'placing'}
                                    title={!isActionable ? 'Place order even though signal is below confidence floor' : 'Place paper order'}
                                    style={{
                                      fontSize: 10, padding: '2px 7px', borderRadius: 4,
                                      cursor: os === 'placing' ? 'wait' : 'pointer',
                                      background: isActionable
                                        ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
                                        : 'color-mix(in srgb, var(--dim) 10%, transparent)',
                                      border: `1px solid ${isActionable ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--dim) 20%, transparent)'}`,
                                      color: isActionable ? 'var(--accent)' : 'var(--dim)',
                                      fontWeight: 600, whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {os === 'placing' ? '⏳' : '📈 Place'}
                                  </button>
                                )}
                                {os === 'placed' && <span style={{ fontSize: 10, color: 'var(--green)' }}>✓ Placed</span>}
                                {os === 'exists' && <span style={{ fontSize: 10, color: 'var(--dim)' }}>Exists</span>}
                                {os && !['placing','placed','exists'].includes(os) && (
                                  <span style={{ fontSize: 10, color: 'var(--red)' }} title={os}>✗ Error</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Education / Glossary page ───────────────────────────────────────────────

