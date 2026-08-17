import { useState, useEffect, useCallback } from 'react'
import {
  ResponsiveContainer,
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine,
  AreaChart, Area, CartesianGrid,
} from 'recharts'

const API = '/api'

// ─── SSE stream reader ────────────────────────────────────────────────────────
// Reads a POST SSE stream and yields parsed JSON payloads.
// EventSource only supports GET, so we use fetch + ReadableStream.

async function* readSSEStream(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE events are separated by double newlines
    const parts = buf.split('\n\n')
    buf = parts.pop() // keep incomplete tail
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)) } catch { /* skip malformed */ }
        }
      }
    }
  }
}

// ─── Shared analysis-stream hook ─────────────────────────────────────────────

const INIT_STEPS = [
  { id: 'fetch',   label: 'Fetch market data',    status: 'pending', elapsed: null, msg: null },
  { id: 'analyze', label: 'AI analysis',           status: 'pending', elapsed: null, msg: null },
  { id: 'detect',  label: 'Detect opportunities',  status: 'pending', elapsed: null, msg: null },
]

function useAnalyzeStream() {
  const [streaming, setStreaming] = useState(false)
  const [steps, setSteps] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const run = useCallback(async (ticker) => {
    const t = ticker.trim().toUpperCase()
    if (!t) return
    setStreaming(true)
    setResult(null)
    setError(null)
    setSteps(INIT_STEPS.map(s => ({ ...s })))

    try {
      for await (const evt of readSSEStream(`${API}/analyze/stream`, { ticker: t, send_alerts: false })) {
        if (evt.type === 'step') {
          setSteps(prev => prev.map(s =>
            s.id === evt.step
              ? { ...s, status: evt.status, elapsed: evt.elapsed ?? s.elapsed, msg: evt.msg ?? s.msg }
              : s
          ))
        } else if (evt.type === 'result') {
          setResult(evt)
        }
      }
    } catch (e) {
      setError(e.message)
      setSteps(prev => prev && prev.map(s => ({
        ...s,
        status: s.status === 'running' ? 'error' : s.status,
      })))
    } finally {
      setStreaming(false)
    }
  }, [])

  return { streaming, steps, result, error, run }
}

// ─── Polling hook ─────────────────────────────────────────────────────────────

function usePolling(path, intervalMs = 0) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(API + path)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [path])

  useEffect(() => {
    load()
    if (!intervalMs) return
    const id = setInterval(load, intervalMs)
    return () => clearInterval(id)
  }, [load, intervalMs])

  return { data, error, reload: load }
}

// ─── InfoTip ──────────────────────────────────────────────────────────────────

function InfoTip({ text }) {
  return (
    <span className="info-tip">
      <span className="info-tip-icon">ℹ</span>
      <span className="info-tip-popup">{text}</span>
    </span>
  )
}

// ─── AnalysisStepper ──────────────────────────────────────────────────────────

const STEP_META = {
  fetch: {
    icon: '📦',
    label: 'Fetch market data',
    subs: ['Price & volume', 'Technical indicators (RSI, MACD, BBands)', 'Fundamentals & news', 'Balance sheet', 'Macro context (FRED)'],
  },
  analyze: {
    icon: '🤖',
    label: 'AI analysis',
    subs: ['Build prompt with all context', 'Call local Ollama model', 'Parse structured response'],
  },
  detect: {
    icon: '🎯',
    label: 'Detect opportunities',
    subs: ['Rule checks (RSI, MACD, volume, P/E)', 'Merge & deduplicate signals', 'Macro regime confidence filter'],
  },
}

function AnalysisStepper({ steps }) {
  const done  = steps.filter(s => s.status === 'done').length
  const total = steps.length
  const pct   = Math.round((done / total) * 100)

  return (
    <div className="stepper">
      <div className="stepper-bar-track">
        <div className="stepper-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {steps.map((step, idx) => {
        const meta = STEP_META[step.id] || { icon: '●', label: step.label, subs: [] }
        return (
          <div key={step.id} className={`step step-v2 ${step.status}`}>
            <div className="step-left">
              <span className="step-num">{idx + 1}</span>
            </div>
            <div className="step-body">
              <div className="step-header-row">
                <span className="step-icon-lg">{meta.icon}</span>
                <span className="step-label">{meta.label}</span>
                {step.elapsed != null && step.status !== 'pending' && (
                  <span className="step-elapsed">{step.elapsed}s</span>
                )}
                <span className={`step-badge step-badge-${step.status}`}>
                  {step.status === 'done' ? '✓ done' : step.status === 'running' ? '⟳ running' : step.status === 'error' ? '✕ error' : 'pending'}
                </span>
              </div>
              {step.status !== 'pending' && (
                <ul className="step-subs">
                  {meta.subs.map(s => <li key={s}>{s}</li>)}
                </ul>
              )}
              {step.status === 'error' && step.msg && (
                <div className="step-msg">{step.msg}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Chart components ─────────────────────────────────────────────────────────

const TIP_RSI = 'RSI (Relative Strength Index) measures price momentum on a 0–100 scale. Below 30 = potentially oversold (price may bounce). Above 70 = potentially overbought (price may pull back). Agreement across multiple timeframes strengthens the signal.'
const TIP_MACD = 'MACD histogram is the difference between the fast and slow moving averages of price. Positive bar (green) = upward momentum building. Negative bar (red) = downward momentum. Bars crossing zero signal a momentum shift.'
const TIP_EMA = 'EMAs (Exponential Moving Averages) smooth price noise. These bars show how far above (+) or below (−) the current price sits relative to each EMA. Green = price above EMA (bullish context). Red = price below EMA (bearish context).'
const TIP_HISTORY = 'Historical daily closing price over the last 3 months. Helps you see the trend context behind the current snapshot. Volume bars below are color-coded: green = close ≥ previous day, red = close < previous day.'

const CHART_TOOLTIP_STYLE = {
  contentStyle: { background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 11 },
  itemStyle: { color: '#e6edf3' },
  labelStyle: { color: '#8b949e' },
}
const AXIS_TICK = { fill: '#8b949e', fontSize: 10 }

function RsiChart({ technicals }) {
  const TFS = ['1H', '4H', '1D']
  const data = TFS
    .map(tf => ({ name: tf, rsi: technicals?.[tf]?.RSI ?? null }))
    .filter(d => d.rsi != null)

  if (data.length === 0) return <div className="chart-empty">No RSI data</div>

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} barCategoryGap="30%">
        <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tick={AXIS_TICK} axisLine={false} tickLine={false} width={28} />
        <Tooltip {...CHART_TOOLTIP_STYLE} formatter={v => [v?.toFixed(1), 'RSI']} />
        <ReferenceLine y={30} stroke="#3fb950" strokeDasharray="3 3" strokeWidth={1} />
        <ReferenceLine y={70} stroke="#f85149" strokeDasharray="3 3" strokeWidth={1} />
        <Bar dataKey="rsi" radius={[3, 3, 0, 0]}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.rsi < 30 ? '#3fb950' : entry.rsi > 70 ? '#f85149' : '#58a6ff'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function MacdChart({ technicals }) {
  const TFS = ['1H', '4H', '1D']
  const data = TFS
    .map(tf => ({ name: tf, hist: technicals?.[tf]?.MACD?.histogram ?? null }))
    .filter(d => d.hist != null)

  if (data.length === 0) return <div className="chart-empty">No MACD data</div>

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} barCategoryGap="30%">
        <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} />
        <Tooltip {...CHART_TOOLTIP_STYLE} formatter={v => [v?.toFixed(4), 'MACD Hist']} />
        <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
        <Bar dataKey="hist" radius={[3, 3, 0, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.hist >= 0 ? '#3fb950' : '#f85149'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function EmaChart({ price, technicals }) {
  const tf = technicals?.['1D']
  const ema20  = tf?.EMA20  ?? null
  const ema50  = tf?.EMA50  ?? null
  const ema200 = tf?.EMA200 ?? null

  if (!price || (!ema20 && !ema50 && !ema200)) {
    return <div className="chart-empty">No EMA data</div>
  }

  const pct = ema => ema ? parseFloat(((price - ema) / ema * 100).toFixed(2)) : null

  const data = [
    { name: 'vs EMA20',  value: pct(ema20)  },
    { name: 'vs EMA50',  value: pct(ema50)  },
    { name: 'vs EMA200', value: pct(ema200) },
  ].filter(d => d.value != null)

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} barCategoryGap="30%">
        <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={36}
               tickFormatter={v => `${v}%`} />
        <Tooltip
          {...CHART_TOOLTIP_STYLE}
          formatter={v => [`${v > 0 ? '+' : ''}${v}%`, 'Price vs EMA']}
        />
        <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
        <Bar dataKey="value" radius={[3, 3, 0, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.value >= 0 ? '#3fb950' : '#f85149'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function MarketCharts({ marketData }) {
  if (!marketData?.technicals) return null
  const price = marketData.price?.current

  return (
    <div className="charts-grid">
      <div className="chart-card">
        <div className="chart-title">RSI <InfoTip text={TIP_RSI} /></div>
        <RsiChart technicals={marketData.technicals} />
      </div>
      <div className="chart-card">
        <div className="chart-title">MACD Histogram <InfoTip text={TIP_MACD} /></div>
        <MacdChart technicals={marketData.technicals} />
      </div>
      <div className="chart-card">
        <div className="chart-title">Price vs EMAs <InfoTip text={TIP_EMA} /></div>
        <EmaChart price={price} technicals={marketData.technicals} />
      </div>
    </div>
  )
}

// ─── Price history chart (Explorer only, toggle-gated) ───────────────────────

function PriceHistoryChart({ ticker }) {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState(null)
  const [histError, setHistError] = useState(null)

  const load = useCallback(async () => {
    if (!ticker) return
    setLoading(true)
    setHistError(null)
    try {
      const res = await fetch(`${API}/market-data/${ticker}/history`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setHistory(data.candles ?? [])
    } catch (e) {
      setHistError(e.message)
    } finally {
      setLoading(false)
    }
  }, [ticker])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    if (next && !history) load()
  }

  return (
    <div className="history-chart-section">
      <div className="history-chart-header">
        <span className="chart-title" style={{ margin: 0 }}>
          📈 Price History (3 months) <InfoTip text={TIP_HISTORY} />
        </span>
        <label className="history-toggle-label">
          <input
            type="checkbox"
            className="history-toggle-input"
            checked={enabled}
            onChange={toggle}
          />
          <span className={`history-toggle-track ${enabled ? 'on' : ''}`}>
            <span className="history-toggle-thumb" />
          </span>
          <span className="history-toggle-text">{enabled ? 'on' : 'off'}</span>
        </label>
      </div>

      {enabled && (
        <div className="history-chart-body">
          {loading && <div className="chart-loading">Loading history…</div>}
          {histError && <div className="error-msg">{histError}</div>}
          {history && history.length > 0 && (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#58a6ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#58a6ff" stopOpacity={0}   />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    interval={Math.max(1, Math.floor((history.length) / 5))}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    width={54}
                    tickFormatter={v => `$${v.toFixed(0)}`}
                  />
                  <Tooltip
                    {...CHART_TOOLTIP_STYLE}
                    formatter={v => [`$${v?.toFixed(2)}`, 'Close']}
                  />
                  <Area
                    type="monotone"
                    dataKey="close"
                    stroke="#58a6ff"
                    strokeWidth={1.5}
                    fill="url(#priceGrad)"
                    dot={false}
                    activeDot={{ r: 3, fill: '#58a6ff' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
              <ResponsiveContainer width="100%" height={48}>
                <BarChart data={history} margin={{ top: 2, right: 8, left: 0, bottom: 0 }} barCategoryGap="0%">
                  <XAxis dataKey="date" hide />
                  <YAxis hide />
                  <Tooltip
                    {...CHART_TOOLTIP_STYLE}
                    formatter={v => [v?.toLocaleString(), 'Volume']}
                  />
                  <Bar dataKey="volume" radius={0}>
                    {history.map((entry, i) => (
                      <Cell key={i} fill={entry.up ? '#3fb95066' : '#f8514966'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
          {history && history.length === 0 && (
            <div className="text-dim" style={{ padding: '12px 0' }}>No history data available.</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Indicator table (collapsible) ────────────────────────────────────────────

function IndicatorTable({ marketData }) {
  if (!marketData?.technicals) return null
  const { technicals } = marketData
  const TFS = ['1H', '4H', '1D']
  const fmtN = v => (v != null ? Number(v).toFixed(2) : '—')

  const rows = [
    { label: 'RSI',         get: d => d?.RSI },
    { label: 'MACD',        get: d => d?.MACD?.macd },
    { label: 'MACD Signal', get: d => d?.MACD?.signal },
    { label: 'MACD Hist',   get: d => d?.MACD?.histogram },
    { label: 'EMA 20',      get: d => d?.EMA20 },
    { label: 'EMA 50',      get: d => d?.EMA50 },
    { label: 'EMA 200',     get: d => d?.EMA200 },
    { label: 'BB Upper',    get: d => d?.BollingerBands?.upper },
    { label: 'BB Lower',    get: d => d?.BollingerBands?.lower },
    { label: 'Stoch K',     get: d => d?.Stochastic?.k },
    { label: 'Stoch D',     get: d => d?.Stochastic?.d },
    { label: 'Signal',      get: d => d?.recommendation, isRec: true },
  ]

  return (
    <details className="indicator-details">
      <summary>📋 Raw indicator data (all timeframes)</summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr>
              <th>Indicator</th>
              {TFS.map(tf => <th key={tf}>{tf}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, get, isRec }) => (
              <tr key={label}>
                <td className="text-dim">{label}</td>
                {TFS.map(tf => {
                  const val = get(technicals[tf])
                  return (
                    <td key={tf}>
                      {isRec
                        ? <span className={`ind-rec ${(val ?? '').toLowerCase()}`}>
                            {val ?? '—'}
                          </span>
                        : fmtN(val)
                      }
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ health, activeView, onViewChange }) {
  const ok   = health?.status === 'ok'
  const open = health?.scheduler?.market_open

  return (
    <header className="header">
      <div className="header-left">
        <span className="logo">MarketSage</span>
        <nav className="header-nav">
          <button
            className={`nav-tab ${activeView === 'dashboard' ? 'active' : ''}`}
            onClick={() => onViewChange('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`nav-tab ${activeView === 'explorer' ? 'active' : ''}`}
            onClick={() => onViewChange('explorer')}
          >
            Explorer
          </button>
          <button
            className={`nav-tab ${activeView === 'education' ? 'active' : ''}`}
            onClick={() => onViewChange('education')}
          >
            Learn
          </button>
        </nav>
      </div>
      <div className="header-right">
        {health ? (
          <div className="header-status">
            <span className={`api-pill ${ok ? 'ok' : 'err'}`}>
              <span className="api-dot" />
              {ok ? 'API' : 'Error'}
            </span>
            <span className={`market-badge ${open ? 'open' : 'closed'}`}>
              {open ? 'Market Open' : 'Market Closed'}
            </span>
          </div>
        ) : (
          <span className="connecting">connecting…</span>
        )}
        <div className="header-tools">
          <a href="http://localhost:18889" target="_blank" rel="noreferrer" className="tool-btn" title="Aspire — traces & logs">Logs</a>
          <a href="http://localhost:9000"  target="_blank" rel="noreferrer" className="tool-btn" title="Portainer — container management">Portainer</a>
          <button
            className={`tool-btn ${activeView === 'settings' ? 'tool-btn-active' : ''}`}
            onClick={() => onViewChange('settings')}
            title="Settings"
          >⚙️</button>
        </div>
      </div>
    </header>
  )
}

// ─── Watchlist card ───────────────────────────────────────────────────────────

function WatchlistCard({ wl, onWatchlistChange }) {
  const [newTicker, setNewTicker] = useState('')
  const [adding, setAdding] = useState(false)

  if (!wl) return <div className="card skeleton" style={{ minHeight: 100 }} />

  const { watchlist, scan_interval_minutes, scheduler } = wl

  const addTicker = async () => {
    const t = newTicker.trim().toUpperCase()
    if (!t) return
    setAdding(true)
    try {
      await fetch(`${API}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t }),
      })
      setNewTicker('')
      onWatchlistChange()
    } finally {
      setAdding(false)
    }
  }

  const removeTicker = async (ticker) => {
    await fetch(`${API}/watchlist/${ticker}`, { method: 'DELETE' })
    onWatchlistChange()
  }

  return (
    <section className="card">
      <div className="card-title">
        Watchlist
        <span className="card-sub">scan every {scan_interval_minutes}m</span>
        <span className={`scheduler-status-chip ${scheduler?.running ? 'running' : 'stopped'}`}>
          {scheduler?.running ? '● scanning' : '○ paused'}
        </span>
      </div>
      <div className="chip-row">
        {watchlist.map((t) => (
          <span key={t} className="chip">
            {t}
            <button className="chip-remove" onClick={() => removeTicker(t)} title={`Remove ${t}`}>×</button>
          </span>
        ))}
      </div>
      <div className="add-ticker-row">
        <input
          className="ticker-input ticker-input-sm"
          value={newTicker}
          onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && addTicker()}
          placeholder="Add ticker…"
          maxLength={10}
          disabled={adding}
        />
        <button
          className="btn-primary btn-sm"
          onClick={addTicker}
          disabled={adding || !newTicker.trim()}
        >+</button>
      </div>
    </section>
  )
}

// ─── LLM Reasoning ───────────────────────────────────────────────────────────

function LLMReasoning({ analysis, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!analysis || analysis.error) return null

  const { trend, momentum, signals = [], risk_factors = [], key_levels = {} } = analysis
  const support    = key_levels?.support    ?? []
  const resistance = key_levels?.resistance ?? []

  return (
    <div className="reasoning-box">
      <button className="reasoning-toggle" onClick={() => setOpen(o => !o)}>
        <span className="reasoning-toggle-label">LLM Reasoning</span>
        <span className="reasoning-badges-inline">
          {trend    && <span className={`rbadge trend-${trend}`}>{trend}</span>}
          {momentum && <span className="rbadge momentum">{momentum}</span>}
        </span>
        <span className="reasoning-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="reasoning-body">
          {signals.length > 0 && (
            <div className="reasoning-section">
              <div className="reasoning-label">Signals</div>
              <ul className="reasoning-list">
                {signals.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {risk_factors.length > 0 && (
            <div className="reasoning-section">
              <div className="reasoning-label risk">Risk Factors</div>
              <ul className="reasoning-list risk">
                {risk_factors.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
          {(support.length > 0 || resistance.length > 0) && (
            <div className="reasoning-levels">
              {support.length > 0 && (
                <span className="level-chip support">
                  S: {support.map(v => Number(v).toFixed(2)).join(' · ')}
                </span>
              )}
              {resistance.length > 0 && (
                <span className="level-chip resistance">
                  R: {resistance.map(v => Number(v).toFixed(2)).join(' · ')}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Analysis result ─────────────────────────────────────────────────────────

function AnalysisResult({ result, onExplore }) {
  // result is the SSE type:"result" payload — includes market_data
  const {
    ticker,
    opportunities = [],
    actionable = [],
    errors = [],
    analysis,
    market_data: marketData,
  } = result

  return (
    <div className="result-box">
      <div className="result-summary">
        <strong>{ticker}</strong>
        <span className="text-dim"> — {opportunities.length} signal{opportunities.length !== 1 ? 's' : ''}, </span>
        <span className={actionable.length ? 'text-green' : 'text-dim'}>
          {actionable.length} actionable
        </span>
      </div>

      {errors.length > 0 && (
        <div className="error-list">
          {errors.map((e, i) => <div key={i}>⚠ {e}</div>)}
        </div>
      )}

      {actionable.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th><th>Conf</th><th>Price</th>
                <th>Entry</th><th>Stop</th><th>Target</th><th>Source</th>
              </tr>
            </thead>
            <tbody>
              {actionable.map((opp, i) => (
                <tr key={i}>
                  <td>
                    <span className={`badge ${opp.type}`}>{opp.type?.toUpperCase() ?? '—'}</span>
                  </td>
                  <td>{(opp.confidence ?? 0).toFixed(0)}%</td>
                  <td>{opp.price?.toFixed(2) ?? '—'}</td>
                  <td>{opp.entry?.toFixed(2) ?? '—'}</td>
                  <td>{opp.stop?.toFixed(2) ?? '—'}</td>
                  <td>{opp.target?.toFixed(2) ?? '—'}</td>
                  <td className="text-dim source-cell">
                    {opp.source ?? (opp.sources ?? []).join('+') ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {opportunities.length > actionable.length && (
        <div className="text-dim below-floor">
          {opportunities.length - actionable.length} below confidence floor
        </div>
      )}

      <MarketCharts marketData={marketData} />
      <LLMReasoning analysis={analysis} />
      <IndicatorTable marketData={marketData} />

      {onExplore && (
        <button
          className="btn-ghost btn-walkthrough"
          onClick={() => onExplore(result)}
        >
          Open in Explorer →
        </button>
      )}
    </div>
  )
}

// ─── On-demand analysis panel (dashboard) ────────────────────────────────────

function AnalyzePanel({ onExplore }) {
  const [ticker, setTicker] = useState('')
  const { streaming, steps, result, error, run } = useAnalyzeStream()

  const handleRun = () => run(ticker)

  return (
    <section className="card analyze-card">
      <div className="card-title">On-Demand Analysis</div>
      <div className="analyze-row">
        <input
          className="ticker-input"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleRun()}
          placeholder="Ticker (e.g. NVDA)"
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
      {error && <div className="error-msg">{error}</div>}
      {steps && <AnalysisStepper steps={steps} />}
      {result && <AnalysisResult result={result} onExplore={onExplore} />}
    </section>
  )
}

// ─── Recent signals ───────────────────────────────────────────────────────────

function fmtN(v) { return v != null ? Number(v).toFixed(2) : '—' }

function fmtTime(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function fmtMarketCap(v) {
  if (v == null) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`
  return `$${Number(v).toLocaleString()}`
}

function fmtNewsDate(epoch) {
  if (!epoch) return ''
  try {
    return new Date(epoch * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch { return '' }
}

/**
 * Horizontal bar chart: Assets / Liabilities / Equity side-by-side.
 * Uses a fixed 320px width to match the indicator charts' style.
 */
function BalanceSheetChart({ bs }) {
  const FILLS = ['#22c55e', '#ef4444', '#3b82f6']
  const data = [
    { name: 'Assets',      value: bs.total_assets },
    { name: 'Liabilities', value: bs.total_liabilities },
    { name: 'Equity',      value: bs.stockholders_equity },
  ].filter(d => d.value != null)
  if (!data.length) return null
  return (
    <BarChart width={320} height={90} data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
      <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#8b949e' }} />
      <YAxis hide />
      <Tooltip
        {...CHART_TOOLTIP_STYLE}
        formatter={(v, name, props) => [fmtMarketCap(v), props.payload.name]}
      />
      <Bar dataKey="value" radius={[3, 3, 0, 0]}>
        {data.map((_, i) => <Cell key={i} fill={FILLS[i % FILLS.length]} />)}
      </Bar>
    </BarChart>
  )
}

/** Returns a CSS class suffix and a plain-English label for a macro metric. */
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

function SignalDetail({ signal, onClose }) {
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`${API}/analysis/${signal.ticker}?limit=5`)
      .then(r => r.json())
      .then(data => {
        const history = data.history ?? []
        const sigTs = new Date(signal.created_at).getTime()
        const closest = history.reduce((best, item) => {
          const diff = Math.abs(new Date(item.created_at).getTime() - sigTs)
          return !best || diff < best.diff ? { item, diff } : best
        }, null)
        setAnalysis(closest?.item?.analysis_json ?? null)
      })
      .catch(() => setAnalysis(null))
      .finally(() => setLoading(false))
  }, [signal])

  return (
    <div className="signal-detail">
      <div className="signal-detail-header">
        <span>
          <strong>{signal.ticker}</strong>
          <span className="text-dim"> · {fmtTime(signal.created_at)}</span>
          <span className={`badge ${signal.type}`} style={{ marginLeft: 8 }}>
            {signal.type?.toUpperCase()}
          </span>
          <span className="text-dim"> · {(signal.confidence ?? 0).toFixed(0)}% confidence</span>
        </span>
        <button className="btn-ghost" onClick={onClose}>✕</button>
      </div>
      {loading ? (
        <div className="text-dim" style={{ padding: '10px 0' }}>Loading analysis…</div>
      ) : analysis ? (
        <LLMReasoning analysis={analysis} defaultOpen={true} />
      ) : (
        <div className="text-dim" style={{ padding: '10px 0' }}>No LLM analysis found for this signal.</div>
      )}
    </div>
  )
}

const SOURCE_LABEL = {
  ai:                '🤖 AI',
  rsi_extreme:       'RSI',
  macd_crossover:    'MACD cross',
  volume_spike:      'Vol ↑',
  valuation_extreme: 'P/E high',
  valuation_cheap:   'P/E low',
  macro_regime:      'Macro',
}

function SignalCard({ r, expanded, onToggle, onDelete }) {
  const isLong = r.type === 'long'
  const conf   = r.confidence ?? 0

  return (
    <div className={`signal-card ${r.type ?? 'unknown'}`}>
      {/* header row */}
      <div className="signal-card-header" onClick={onToggle} style={{ cursor: 'pointer' }}>
        <div className="signal-card-left">
          <span className="signal-ticker">{r.ticker}</span>
          <span className={`badge ${r.type}`} style={{ marginLeft: 8 }}>
            {r.type?.toUpperCase() ?? '—'}
          </span>
          <span className="signal-time text-dim">{fmtTime(r.created_at)}</span>
        </div>
        <div className="signal-card-right">
          <div className="signal-conf-wrap">
            <span className="signal-conf-pct" style={{ color: isLong ? 'var(--green)' : 'var(--red)' }}>
              {conf.toFixed(0)}%
            </span>
            <div className="signal-conf-track">
              <div
                className="signal-conf-fill"
                style={{
                  width: `${conf}%`,
                  background: isLong ? 'var(--green)' : 'var(--red)',
                  opacity: 0.85,
                }}
              />
            </div>
          </div>
          <button
            className="btn-delete"
            onClick={e => { e.stopPropagation(); onDelete() }}
            title="Delete"
          >×</button>
        </div>
      </div>

      {/* price grid */}
      <div className="signal-levels-grid">
        {[['Price', r.price], ['Entry', r.entry], ['Stop', r.stop], ['Target', r.target]].map(([lbl, val]) => (
          <div key={lbl} className="signal-level-cell">
            <span className="signal-level-label">{lbl}</span>
            <span className="signal-level-value">{fmtN(val)}</span>
          </div>
        ))}
      </div>

      {/* source chips */}
      {r.source && (
        <div className="signal-sources">
          {r.source.split('+').map(s => (
            <span key={s} className="signal-chip">{SOURCE_LABEL[s.trim()] ?? s.trim()}</span>
          ))}
        </div>
      )}

      {/* expanded: LLM reasoning */}
      {expanded && r.llm_analysis && (
        <div className="signal-reasoning">
          <div className="signal-reasoning-label">AI Reasoning</div>
          <div className="signal-reasoning-body">{r.llm_analysis}</div>
        </div>
      )}
    </div>
  )
}

function SignalsTable({ signals, reload }) {
  const [open,         setOpen]         = useState(false)
  const [filterSide,   setFilterSide]   = useState('all')
  const [filterConf,   setFilterConf]   = useState(0)
  const [filterTicker, setFilterTicker] = useState('')
  const [expanded,     setExpanded]     = useState(null)

  if (!signals) return <div className="card skeleton" style={{ minHeight: 80 }} />

  const allRows = signals.signals ?? []

  const rows = allRows.filter(r => {
    if (filterSide !== 'all' && r.type !== filterSide) return false
    if ((r.confidence ?? 0) < filterConf) return false
    if (filterTicker && !r.ticker?.includes(filterTicker.toUpperCase())) return false
    return true
  })

  const handleDelete = async (id) => {
    if (!confirm('Delete this signal?')) return
    await fetch(`${API}/signals/${id}`, { method: 'DELETE' }).catch(() => {})
    if (expanded === id) setExpanded(null)
    reload()
  }

  const longCount  = allRows.filter(r => r.type === 'long').length
  const shortCount = allRows.filter(r => r.type === 'short').length

  return (
    <details
      className="card signals-collapsible"
      open={open}
      onToggle={e => setOpen(e.target.open)}
    >
      <summary className="signals-summary">
        <div className="signals-summary-left">
          <span className="card-title" style={{ margin: 0 }}>📊 Signals</span>
          <span className="text-dim" style={{ fontSize: 13 }}>
            {allRows.length} stored
          </span>
          {allRows.length > 0 && (
            <div className="signals-summary-badges">
              {longCount  > 0 && <span className="badge long">{longCount} long</span>}
              {shortCount > 0 && <span className="badge short">{shortCount} short</span>}
            </div>
          )}
        </div>
        <div className="signals-summary-right">
          <button
            className="btn-ghost"
            onClick={e => { e.stopPropagation(); e.preventDefault(); reload() }}
            title="Refresh"
          >↻</button>
          <span className="section-chevron">{open ? '▲' : '▼'}</span>
        </div>
      </summary>

      {/* Filter bar */}
      {allRows.length > 0 && (
        <div className="signals-filters">
          <div className="filter-group">
            {['all', 'long', 'short'].map(s => (
              <button
                key={s}
                className={`filter-btn ${filterSide === s ? 'active' : ''}`}
                onClick={() => setFilterSide(s)}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          <div className="filter-group">
            <label className="filter-label">Min conf</label>
            <input
              type="range" min={0} max={100} step={5}
              value={filterConf}
              onChange={e => setFilterConf(Number(e.target.value))}
              className="filter-range"
            />
            <span className="filter-val">{filterConf}%</span>
          </div>

          <div className="filter-group">
            <input
              type="text"
              placeholder="Ticker…"
              value={filterTicker}
              onChange={e => setFilterTicker(e.target.value)}
              className="filter-ticker-input"
            />
          </div>

          {(filterSide !== 'all' || filterConf > 0 || filterTicker) && (
            <button
              className="btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => { setFilterSide('all'); setFilterConf(0); setFilterTicker('') }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Cards */}
      <div style={{ padding: '0 16px 16px' }}>
        {rows.length === 0 && allRows.length === 0 && (
          <div className="text-dim empty">No signals stored yet.</div>
        )}
        {rows.length === 0 && allRows.length > 0 && (
          <div className="text-dim empty">No signals match the current filters.</div>
        )}
        <div className="signals-cards-grid">
          {rows.map(r => (
            <SignalCard
              key={r.id}
              r={r}
              expanded={expanded === r.id}
              onToggle={() => setExpanded(prev => prev === r.id ? null : r.id)}
              onDelete={() => handleDelete(r.id)}
            />
          ))}
        </div>
      </div>
    </details>
  )
}

// ─── Analysis Explorer page ───────────────────────────────────────────────────

function ExplorerPage({ initialResult, onBack, modelName, onOpenInExplorer }) {
  const [ticker, setTicker] = useState(initialResult?.ticker ?? '')
  const { streaming, steps, result: streamResult, error, run } = useAnalyzeStream()

  // Use streamed result if available, otherwise show pre-loaded result from dashboard
  const result    = streamResult ?? initialResult
  const mkt       = result?.market_data
  const price     = mkt?.price
  const analysis  = result?.analysis
  const opps      = result?.opportunities ?? []
  const actionable = result?.actionable ?? []
  const errors    = result?.errors ?? []

  const handleRun = () => run(ticker)

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
      <AnalysisHistoryPanel onOpenInExplorer={onOpenInExplorer} />

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
            <span className="section-badge">Step 1</span>
            <span className="section-label">Pipeline walkthrough</span>
          </div>
          <p className="section-desc">
            Every analysis runs three steps: <strong>fetch</strong> live market data from yfinance
            and TradingView, <strong>analyze</strong> it with the local AI model (no data leaves your
            machine), then <strong>detect</strong> opportunities by combining AI output with
            rule-based checks (RSI extremes, MACD crossovers, volume spikes).
          </p>
          {steps
            ? <AnalysisStepper steps={steps} />
            : result && (
              <AnalysisStepper steps={INIT_STEPS.map(s => ({ ...s, status: 'done' }))} />
            )
          }
        </div>
      )}

      {/* Section 2 — Price snapshot */}
      {price && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">Step 2</span>
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
            <span className="section-badge">Step 3</span>
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
            <span className="section-badge">Step 4</span>
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
            <span className="section-chevron">›</span>
          </summary>
          <p className="section-desc">
            Last 7 days of company news from Finnhub. Headlines are included in the AI prompt
            so the model can factor in recent events. Requires a free{' '}
            <code>FINNHUB_API_KEY</code> in <code>.env</code>.
          </p>
          {mkt.news?.length > 0 ? (
            <ul className="news-list">
              {mkt.news.map((item, i) => (
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
                    {item.source && <span>{item.source}</span>}
                    {item.datetime && <span>{fmtNewsDate(item.datetime)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-dim" style={{ fontSize: 12 }}>
              No recent headlines — set <code>FINNHUB_API_KEY</code> in <code>.env</code> to enable.
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
      {analysis && !analysis.error && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">Step 5</span>
            <span className="section-label">AI reasoning {modelName && <span className="text-dim">({modelName})</span>}</span>
          </div>
          <p className="section-desc">
            The local Ollama model receives all indicator data as a structured prompt and
            returns a JSON analysis: trend direction, momentum, key price levels, supporting
            signals and risk factors. Runs entirely on your machine — no cloud API calls.
          </p>
          <LLMReasoning analysis={analysis} defaultOpen={true} />
        </div>
      )}

      {/* Section 6 — Detected opportunities */}
      {result && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">Step 6</span>
            <span className="section-label">Signals detected</span>
          </div>
          <p className="section-desc">
            Opportunities are scored by merging AI confidence with four rule-based checks
            (RSI extreme, volume spike, MACD crossover, AI signal). Only entries at or above
            the confidence floor are marked actionable and trigger alerts.
          </p>
          {errors.length > 0 && (
            <div className="error-list">{errors.map((e, i) => <div key={i}>⚠ {e}</div>)}</div>
          )}
          {actionable.length === 0 && opps.length === 0 && (
            <div className="text-dim">No signals detected.</div>
          )}
          {actionable.length === 0 && opps.length > 0 && (
            <div className="text-dim">{opps.length} signal(s) detected but all below confidence floor.</div>
          )}
          {actionable.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th><th>Conf</th><th>Price</th>
                    <th>Entry</th><th>Stop</th><th>Target</th><th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {actionable.map((opp, i) => (
                    <tr key={i}>
                      <td><span className={`badge ${opp.type}`}>{opp.type?.toUpperCase() ?? '—'}</span></td>
                      <td>{(opp.confidence ?? 0).toFixed(0)}%</td>
                      <td>{opp.price?.toFixed(2) ?? '—'}</td>
                      <td>{opp.entry?.toFixed(2) ?? '—'}</td>
                      <td>{opp.stop?.toFixed(2) ?? '—'}</td>
                      <td>{opp.target?.toFixed(2) ?? '—'}</td>
                      <td className="text-dim source-cell">
                        {opp.source ?? (opp.sources ?? []).join('+') ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Education / Glossary page ───────────────────────────────────────────────

const GLOSSARY_TERMS = [
  ['Bearish',              'Expecting price to fall. A bearish signal suggests a potential short opportunity.'],
  ['Bullish',              'Expecting price to rise. A bullish signal suggests a potential long opportunity.'],
  ['CAPE / Shiller P/E',   '10-year inflation-adjusted P/E ratio for the S&P 500 as a whole. Values above 30 indicate elevated market-wide valuation; below 15 is historically cheap. Used in the macro regime filter (Rule 6).'],
  ['Confidence',           '0–100 score combining AI confidence and rule-based evidence. Higher = stronger agreement across sources.'],
  ['Confidence floor',     'Minimum confidence to be considered actionable (default: 65). Filters out weak / uncertain signals.'],
  ['CPI',                  'Consumer Price Index — measures the rate of consumer price inflation. The Fed targets 2% YoY. High CPI forces the Fed to keep rates elevated, which compresses equity valuation multiples. Shown in the Macro card.'],
  ['Death Cross',          'EMA 50 crossing below EMA 200 — a long-term bearish signal that often attracts institutional selling.'],
  ['Debt-to-Equity (D/E)', "Total debt divided by stockholders' equity. Measures financial leverage. High D/E amplifies both gains and losses in downturns. A D/E above 3 is considered highly leveraged; context varies by sector (utilities and banks naturally carry more debt)."],
  ['Entry',                'Suggested price at which to open the position. Typically near the current price at signal time.'],
  ['Fed Funds Rate',       "The US Federal Reserve's benchmark overnight lending rate. Higher rates raise borrowing costs across the economy and compress equity valuation multiples by making bonds relatively more attractive."],
  ['Forward P/E',          'Price divided by consensus analyst EPS estimate for the next 12 months. A forward P/E lower than the trailing P/E implies the market expects earnings growth; higher implies expected contraction.'],
  ['Golden Cross',         'EMA 50 crossing above EMA 200 — a long-term bullish signal widely watched by institutional traders.'],
  ['Long',                 'Buying a security expecting its price to rise. Profit = price at exit − price at entry.'],
  ['Macro regime',         '"Tailwind" conditions: low rates, low inflation, normal (upward-sloping) yield curve. "Headwind" conditions: inverted yield curve, high inflation, restrictive Fed. Rule 6 adjusts opportunity confidence scores accordingly.'],
  ['OHLCV',                'Open, High, Low, Close, Volume — the five values in a price candle. Every bar on a chart encodes these.'],
  ['R-multiple',           '(Target − Entry) ÷ (Entry − Stop). A 2R trade means your potential profit is twice your risk. Aim for ≥ 2R.'],
  ['Resistance',           'A price level where selling pressure has historically been strong — like a ceiling the price struggles to break through.'],
  ['Short',                "Selling a security you don't own (borrowing it) expecting its price to fall. Profit = price at entry − price at exit."],
  ['Stop',                 'The price at which to exit if the trade goes wrong. Caps your loss. Set it at a technically significant level (e.g. below support).'],
  ['Support',              'A price level where buying interest has historically been strong — like a floor the price bounces off.'],
  ['Target',               'The price goal if the trade goes your way. Sets your reward level for the R-multiple calculation.'],
  ['Timeframe',            '1H = each candle covers 1 hour. 4H = 4 hours. 1D = one full trading day. Longer timeframes filter more noise.'],
  ['Trailing P/E (TTM)',   'Price divided by actual earnings over the trailing twelve months. A classic valuation measure. Context varies heavily by sector. Negative P/E (loss-making companies) cannot be interpreted as "cheap".'],
  ['Trend',                'Sustained directional movement. Uptrend: higher highs and higher lows. Downtrend: lower highs and lower lows. Sideways: neither.'],
  ['Volume spike',         'Unusually high volume (> 1.5× average). Often triggered by news, earnings surprises, or institutional order flow.'],
  ['Yield curve inversion','When the 2-year US Treasury yield exceeds the 10-year yield, the curve is "inverted". Has preceded every US recession since the 1960s. Shown with ⚠ in the Macro card; applies −8 confidence to long signals (Rule 6).'],
]

function GlossarySection() {
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const filtered = q
    ? GLOSSARY_TERMS.filter(([term, def]) =>
        term.toLowerCase().includes(q) || def.toLowerCase().includes(q))
    : GLOSSARY_TERMS

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
      {filtered.length === 0
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
      }
    </EduSection>
  )
}

function EduSection({ id, title, badge, children, defaultOpen = false }) {
  return (
    <details id={id} className="edu-section" open={defaultOpen}>
      <summary className="edu-summary">
        {badge && <span className="section-badge">{badge}</span>}
        <span className="edu-summary-title">{title}</span>
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
  { id: 'edu-glossary',      label: 'Glossary' },
  { id: 'edu-further',       label: 'Further reading' },
]

function EducationPage() {
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
          through the same six steps:
        </p>
        <ol className="edu-steps">
          <li>
            <strong>yfinance</strong> — fetches live price, volume, day change, fundamentals
            (name, sector, industry, market cap, P/E trailing + forward) and 20-day averages.
            Free, no API key. The annual balance sheet is also fetched here (daily cache).
          </li>
          <li>
            <strong>yfinance + ta library</strong> — OHLCV history is downloaded for three
            timeframes (1H, 4H, 1D) and all indicators (RSI, MACD, EMA 20/50/200, Bollinger
            Bands, Stochastic) are computed locally using the open-source{' '}
            <code>ta</code> library. No account or API key needed; fully offline.
          </li>
          <li>
            <strong>FRED + multpl.com</strong> — US macro context is fetched from the Federal
            Reserve's key-free CSV API (Fed funds rate, CPI, unemployment, yield curve) and
            Shiller CAPE from multpl.com. Cached globally for 6 hours across all tickers.
          </li>
          <li>
            <strong>Finnhub</strong> (optional) — recent company news headlines including
            source and date. Requires a free <code>FINNHUB_API_KEY</code>.
          </li>
          <li>
            <strong>Local Ollama AI</strong> — all of the above (price, indicators, balance
            sheet health, macro environment, P/E, recent news) is assembled into a structured
            prompt and sent to the local model (default: <code>qwen2.5:14b</code>).
            Nothing leaves your machine. Every LLM call is traced in Aspire with input/output
            token counts and time-to-first-token (TTFT).
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
          After the AI analysis runs, four independent rule-based checks are applied to the
          same market data. Any check that fires creates a candidate signal. Candidates for the
          same ticker are merged and their confidence scores are combined.
        </p>

        <div className="edu-rules">
          {[
            {
              num: 1, icon: '🤖', title: 'AI signal',
              side: 'both', conf: '65–95',
              trigger: 'LLM returns long/short with confidence ≥ floor',
              body: <>The local model returns a <code>long</code> or <code>short</code> direction with a confidence value. If confidence ≥ the floor (default: 65), a candidate is raised with the AI's entry, stop and target suggestions.</>,
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
          are boosted by each additional agreeing rule. Rule 6 runs post-merge. The final score
          must still clear the confidence floor to be actionable.
        </p>
      </EduSection>

      {/* Section 6 — Glossary with live search */}
      <GlossarySection />

      {/* Section 7 — Disclaimer + further reading */}
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

// ─── Analysis history panel ──────────────────────────────────────────────────

function AnalysisHistoryPanel({ onOpenInExplorer }) {
  const [expanded, setExpanded] = useState(false)
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    fetch(`${API}/analysis?limit=25`)
      .then(r => r.json())
      .then(data => { setHistory(data.history ?? []); setLoading(false) })
      .catch(e  => { setErr(e.message); setLoading(false) })
  }, [])

  // Load data the first time the panel is opened
  useEffect(() => { if (expanded && history === null) load() }, [expanded, history, load])

  const openRow = (row) => {
    onOpenInExplorer({
      ticker:       row.ticker,
      analysis:     row.analysis_json,
      market_data:  row.market_snapshot,
      opportunities: [],
      actionable:   [],
      errors:       [],
      _from_history: true,
      _history_at:  row.created_at,
    })
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this analysis entry?')) return
    await fetch(`${API}/analysis/${id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  return (
    <section className="card history-panel">
      <div className="card-title history-panel-header" onClick={() => setExpanded(o => !o)}>
        <span className={`history-panel-chevron${expanded ? ' open' : ''}`}>›</span>
        Analysis History
        {history != null && !expanded && (
          <span className="card-sub">{history.length} saved</span>
        )}
        {expanded && (
          <button
            className="btn-ghost"
            style={{ fontSize: 11, padding: '1px 8px' }}
            onClick={e => { e.stopPropagation(); load() }}
          >↺ Refresh</button>
        )}
      </div>

      {expanded && (
        <>
          {loading && <div className="empty">Loading…</div>}
          {err    && <div className="error-msg">Could not load history: {err}</div>}
          {history && history.length === 0 && (
            <div className="empty">No analyses saved yet — run an analysis in the Explorer above.</div>
          )}
          {history && history.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Trend</th>
                    <th>Confidence</th>
                    <th>Run at</th>
                    <th></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(row => {
                    const aj    = row.analysis_json ?? {}
                    const trend = aj.trend ?? '—'
                    const conf  = aj.confidence
                    return (
                      <tr key={row.id}>
                        <td><span className="badge-ticker">{row.ticker}</span></td>
                        <td><span className={`rbadge trend-${trend}`}>{trend}</span></td>
                        <td>{conf != null ? `${conf}%` : '—'}</td>
                        <td className="ts">{fmtTime(row.created_at)}</td>
                        <td>
                          <button className="btn-open-history" onClick={() => openRow(row)}>
                            Open in Explorer →
                          </button>
                        </td>
                        <td>
                          <button className="btn-delete" onClick={() => handleDelete(row.id)} title="Delete">×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

// ─── Settings page ────────────────────────────────────────────────────────────

function SettingSection({ title, icon, children }) {
  return (
    <div className="settings-section">
      <div className="settings-section-title">{icon} {title}</div>
      {children}
    </div>
  )
}

function SaveRow({ status, errMsg, onSave, label = 'Save' }) {
  return (
    <div className="settings-save-row">
      <button className="btn-primary btn-sm" onClick={onSave} disabled={status === 'saving'}>
        {status === 'saving' ? 'Saving…' : label}
      </button>
      {status === 'ok'    && <span className="settings-ok">✓ Saved</span>}
      {status === 'error' && <span className="settings-err">✗ {errMsg || 'Failed'}</span>}
    </div>
  )
}

function SettingsPage() {
  // ── Ollama model + timeout ──────────────────────────────────────────────────
  const [models,  setModels]  = useState([])
  const [model,   setModel]   = useState('')
  const [timeout, setTimeout_] = useState('')
  const [ollamaStatus, setOllamaStatus] = useState(null)
  const [ollamaErr,    setOllamaErr]    = useState('')

  // ── Scheduler + scan interval ───────────────────────────────────────────────
  const [schedulerRunning,  setSchedulerRunning]  = useState(true)
  const [scanInterval,      setScanInterval]      = useState('15')
  const [schedStatus,       setSchedStatus]       = useState(null)
  const [schedErr,          setSchedErr]          = useState('')

  // ── Alerts ──────────────────────────────────────────────────────────────────
  const [alertsOn,     setAlertsOn]     = useState(true)
  const [alertsStatus, setAlertsStatus] = useState(null)

  // ── Data reset ──────────────────────────────────────────────────────────────
  const [resetStatus, setResetStatus] = useState(null)

  // Load on mount
  useEffect(() => {
    Promise.all([
      fetch(`${API}/settings`).then(r => r.json()),
      fetch(`${API}/settings/models`).then(r => r.json()),
    ]).then(([cfg, m]) => {
      setModel(cfg.ollama_model ?? '')
      setTimeout_(String(cfg.ollama_timeout ?? 120))
      setModels(m.models ?? [])
      setScanInterval(String(cfg.scan_interval_minutes ?? 15))
      setSchedulerRunning(cfg.scheduler_running ?? true)
      setAlertsOn(cfg.alerts_enabled ?? true)
    }).catch(() => {})
  }, [])

  const saveOllama = async () => {
    setOllamaStatus('saving'); setOllamaErr('')
    try {
      const body = {}
      if (model)   body.model   = model
      if (timeout) body.timeout = parseInt(timeout, 10)
      const r = await fetch(`${API}/settings/ollama`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      setOllamaStatus('ok')
      setTimeout(() => setOllamaStatus(null), 3000)
    } catch (e) { setOllamaStatus('error'); setOllamaErr(e.message) }
  }

  const saveScheduler = async () => {
    setSchedStatus('saving'); setSchedErr('')
    try {
      await fetch(`${API}/settings/scan-interval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: parseInt(scanInterval, 10) }),
      })
      setSchedStatus('ok')
      setTimeout(() => setSchedStatus(null), 3000)
    } catch (e) { setSchedStatus('error'); setSchedErr(e.message) }
  }

  const toggleScheduler = async () => {
    const next = !schedulerRunning
    setSchedulerRunning(next)          // optimistic update
    try {
      const r = await fetch(`${API}/settings/scheduler`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ running: next }),
      })
      if (r.ok) {
        const data = await r.json()
        setSchedulerRunning(data.running ?? next)   // reconcile with server
      } else {
        setSchedulerRunning(!next)                  // revert on error
      }
    } catch (e) { setSchedulerRunning(!next) }      // revert on network error
  }

  const toggleAlerts = async () => {
    const next = !alertsOn
    try {
      await fetch(`${API}/settings/alerts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      setAlertsOn(next)
      setAlertsStatus('ok')
      setTimeout(() => setAlertsStatus(null), 2000)
    } catch (e) { /* best-effort */ }
  }

  const resetData = async () => {
    if (!window.confirm('Clear ALL signals and analysis history? App settings (watchlist, model, interval) will be preserved. This cannot be undone.')) return
    setResetStatus('clearing')
    try {
      const r = await fetch(`${API}/data/reset`, { method: 'POST' })
      if (!r.ok) throw new Error(await r.text())
      setResetStatus('ok')
      setTimeout(() => setResetStatus(null), 4000)
    } catch (e) { setResetStatus('error') }
  }

  return (
    <div className="settings-page">

      {/* ── Scheduler ─────────────────────────────────────────────────────── */}
      <SettingSection title="Scheduler" icon="🕐">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          The scheduler automatically scans every ticker in your watchlist while
          the US market is open. You can pause it without stopping the container.
        </p>

        <div className="settings-row">
          <div className="settings-row-label">
            <span>Auto-scan</span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {schedulerRunning ? 'Running — scanning on schedule' : 'Stopped — manual runs only'}
            </span>
          </div>
          <button
            className={`settings-toggle ${schedulerRunning ? 'on' : 'off'}`}
            onClick={toggleScheduler}
            title={schedulerRunning ? 'Stop scheduler' : 'Start scheduler'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="settings-row" style={{ marginTop: 12 }}>
          <div className="settings-row-label">
            <span>Scan interval</span>
            <span className="text-dim" style={{ fontSize: 12 }}>Minutes between automatic scans</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="number" min={1} max={1440}
              value={scanInterval}
              onChange={e => setScanInterval(e.target.value)}
              className="settings-num-input"
            />
            <span className="text-dim" style={{ fontSize: 13 }}>min</span>
          </div>
        </div>
        <SaveRow status={schedStatus} errMsg={schedErr} onSave={saveScheduler} label="Apply interval" />
      </SettingSection>

      {/* ── Alerts ────────────────────────────────────────────────────────── */}
      <SettingSection title="Alerts" icon="🔔">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Enable or disable outbound alert dispatch (email, Slack, Telegram).
          Toggling here is instant — no restart required.
        </p>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Alert dispatch</span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {alertsOn ? 'Alerts will be sent on actionable signals' : 'All alert channels suppressed'}
            </span>
          </div>
          <button
            className={`settings-toggle ${alertsOn ? 'on' : 'off'}`}
            onClick={toggleAlerts}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {alertsStatus === 'ok' && (
          <div className="settings-ok" style={{ marginTop: 8 }}>✓ Updated</div>
        )}
      </SettingSection>

      {/* ── Ollama ────────────────────────────────────────────────────────── */}
      <SettingSection title="Ollama (Local LLM)" icon="🤖">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Only models already pulled in Ollama are listed. Match model size to
          GPU VRAM: 3b ≈ 3 GB · 7b ≈ 5 GB · 14b ≈ 10 GB.
          To pull a new model: <code className="inline-code">docker exec ollama ollama pull &lt;model&gt;</code>
        </p>

        <div className="settings-field">
          <label className="settings-label">Model</label>
          {models.length > 0 ? (
            <select value={model} onChange={e => setModel(e.target.value)} className="settings-select">
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input type="text" value={model} onChange={e => setModel(e.target.value)}
              placeholder="e.g. qwen2.5:7b" className="settings-select" />
          )}
        </div>

        <div className="settings-field">
          <label className="settings-label">Request timeout</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min={10} max={3600} value={timeout}
              onChange={e => setTimeout_(e.target.value)} className="settings-num-input" />
            <span className="text-dim" style={{ fontSize: 13 }}>seconds</span>
          </div>
        </div>

        <SaveRow status={ollamaStatus} errMsg={ollamaErr} onSave={saveOllama} label="Save model settings" />
      </SettingSection>

      {/* ── Data ──────────────────────────────────────────────────────────── */}
      <SettingSection title="Data" icon="🗑️">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Clear all stored signals and analysis history. App settings (watchlist,
          interval, model, alerts) are preserved. This cannot be undone.
        </p>
        <div className="settings-save-row">
          <button className="btn-danger btn-sm" onClick={resetData} disabled={resetStatus === 'clearing'}>
            {resetStatus === 'clearing' ? 'Clearing…' : 'Clear all data'}
          </button>
          {resetStatus === 'ok'    && <span className="settings-ok">✓ All signals and analyses cleared</span>}
          {resetStatus === 'error' && <span className="settings-err">✗ Reset failed — see backend logs</span>}
        </div>
      </SettingSection>

    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const { data: health }                        = usePolling('/health', 30_000)
  const { data: wl, reload: reloadWatchlist }   = usePolling('/watchlist', 60_000)
  const { data: signals, reload: reloadSignals } = usePolling('/signals?limit=30', 60_000)

  const [activeView, setActiveView] = useState('dashboard')
  const [explorerState, setExplorerState] = useState(null)
  // Increment to force-remount ExplorerPage only when a new result arrives from Dashboard.
  // Tab switching leaves explorerKey unchanged so the running SSE stream is preserved.
  const [explorerKey, setExplorerKey] = useState(0)

  const openExplorer = (result) => {
    setExplorerState(result)
    setExplorerKey(k => k + 1)   // reset Explorer state for the new result
    setActiveView('explorer')
  }

  return (
    <div className="app">
      <Header health={health} activeView={activeView} onViewChange={setActiveView} />
      <main className="main">
        {/* All three views are always mounted — switching tabs never destroys SSE state */}
        <div style={{ display: activeView === 'dashboard' ? 'flex' : 'none',
                      flexDirection: 'column', gap: 16 }}>
          <WatchlistCard wl={wl} onWatchlistChange={reloadWatchlist} />
          <SignalsTable signals={signals} reload={reloadSignals} />
        </div>
        <div style={{ display: activeView === 'explorer' ? '' : 'none' }}>
          <ExplorerPage
            key={explorerKey}
            initialResult={explorerState}
            onBack={() => setActiveView('dashboard')}
            modelName={health?.ollama_model}
            onOpenInExplorer={openExplorer}
          />
        </div>
        {activeView === 'education' && <EducationPage />}
        {activeView === 'settings' && <SettingsPage />}
      </main>
      <footer className="footer">
        <span className="footer-brand">MarketSage</span>
        {health && (
          <>
            <span className="footer-sep">·</span>
            <span>v{health.version}</span>
            <span className="footer-sep">·</span>
            <span>{health.ollama_model}</span>
          </>
        )}
        <span className="footer-sep">·</span>
        <span>Built {new Date(__BUILD_TIME__).toLocaleString()}</span>
        <span className="footer-sep">·</span>
        <span className="footer-disclaimer">Not financial advice</span>
      </footer>
    </div>
  )
}
