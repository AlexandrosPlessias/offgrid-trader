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

function stepIcon(status) {
  if (status === 'done')    return '✓'
  if (status === 'running') return '⟳'
  if (status === 'error')   return '✕'
  return '·'
}

function AnalysisStepper({ steps }) {
  return (
    <div className="stepper">
      {steps.map(step => (
        <div key={step.id} className={`step ${step.status}`}>
          <span className="step-icon">{stepIcon(step.status)}</span>
          <span className="step-label">{step.label}</span>
          {step.status === 'error' && step.msg && (
            <span className="step-msg">{step.msg}</span>
          )}
          {step.elapsed != null && step.status !== 'pending' && (
            <span className="step-elapsed">{step.elapsed}s</span>
          )}
        </div>
      ))}
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
    .map(tf => ({ name: tf, rsi: technicals?.[tf]?.rsi ?? null }))
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
    .map(tf => ({ name: tf, hist: technicals?.[tf]?.macd_hist ?? null }))
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
  const ema20  = tf?.ema20  ?? null
  const ema50  = tf?.ema50  ?? null
  const ema200 = tf?.ema200 ?? null

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
    { label: 'RSI',         key: 'rsi' },
    { label: 'MACD',        key: 'macd' },
    { label: 'MACD Signal', key: 'macd_signal' },
    { label: 'MACD Hist',   key: 'macd_hist' },
    { label: 'EMA 20',      key: 'ema20' },
    { label: 'EMA 50',      key: 'ema50' },
    { label: 'EMA 200',     key: 'ema200' },
    { label: 'BB Upper',    key: 'bb_upper' },
    { label: 'BB Lower',    key: 'bb_lower' },
    { label: 'Stoch K',     key: 'stoch_k' },
    { label: 'Stoch D',     key: 'stoch_d' },
    { label: 'Signal',      key: 'recommendation' },
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
            {rows.map(({ label, key }) => (
              <tr key={key}>
                <td className="text-dim">{label}</td>
                {TFS.map(tf => (
                  <td key={tf}>
                    {key === 'recommendation'
                      ? <span className={`ind-rec ${(technicals[tf]?.[key] ?? '').toLowerCase()}`}>
                          {technicals[tf]?.[key] ?? '—'}
                        </span>
                      : fmtN(technicals[tf]?.[key])
                    }
                  </td>
                ))}
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
          <div className="header-meta">
            <span className={`dot ${ok ? 'green' : 'red'}`} title={ok ? 'backend online' : 'backend error'} />
            <span className={`market-badge ${open ? 'open' : 'closed'}`}>
              {open ? '● Market Open' : '○ Market Closed'}
            </span>
          </div>
        ) : (
          <span className="connecting">connecting…</span>
        )}
        <div className="header-tools">
          <a href="http://localhost:18889" target="_blank" rel="noreferrer" className="tool-btn" title="Aspire — traces & logs">Logs</a>
          <a href="http://localhost:9000"  target="_blank" rel="noreferrer" className="tool-btn" title="Portainer — container management">Portainer</a>
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

  const { watchlist, scan_interval_minutes, scheduler, alerts_enabled: alertsOn = true } = wl

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

  const toggleAlerts = async () => {
    await fetch(`${API}/settings/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !alertsOn }),
    })
    onWatchlistChange()
  }

  return (
    <section className="card">
      <div className="card-title">
        Watchlist
        <span className="card-sub">scan every {scan_interval_minutes}m</span>
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
      <div className="scheduler-row">
        Scheduler&nbsp;
        <span className={scheduler?.running ? 'text-green' : 'text-dim'}>
          {scheduler?.running ? 'running' : 'stopped'}
        </span>
        {scheduler?.last_run && (
          <span className="text-dim">
            &nbsp;· last {new Date(scheduler.last_run).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="alerts-row">
        Alerts
        <button
          className={`alerts-toggle ${alertsOn ? 'on' : 'off'}`}
          onClick={toggleAlerts}
          title={alertsOn ? 'Click to disable alert dispatch' : 'Click to enable alert dispatch'}
        >
          {alertsOn ? 'ON' : 'OFF'}
        </button>
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

function SignalsTable({ signals, reload }) {
  const [selected, setSelected] = useState(null)

  if (!signals) return <div className="card skeleton" style={{ minHeight: 120 }} />

  const rows = signals.signals ?? []

  return (
    <section className="card">
      <div className="card-title">
        Recent Signals
        <span className="card-sub">{rows.length} shown · click a row for LLM reasoning</span>
        <button className="btn-ghost" onClick={reload} title="Refresh">↻</button>
      </div>

      {rows.length === 0 ? (
        <div className="text-dim empty">No signals stored yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th><th>Ticker</th><th>Type</th><th>Conf</th>
                <th>Price</th><th>Entry</th><th>Stop</th><th>Target</th><th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={r.id}
                  className={`clickable-row${selected?.id === r.id ? ' row-selected' : ''}`}
                  onClick={() => setSelected(prev => prev?.id === r.id ? null : r)}
                >
                  <td className="text-dim ts">{fmtTime(r.created_at)}</td>
                  <td><strong>{r.ticker}</strong></td>
                  <td><span className={`badge ${r.type}`}>{r.type?.toUpperCase() ?? '—'}</span></td>
                  <td>{(r.confidence ?? 0).toFixed(0)}%</td>
                  <td>{fmtN(r.price)}</td>
                  <td>{fmtN(r.entry)}</td>
                  <td>{fmtN(r.stop)}</td>
                  <td>{fmtN(r.target)}</td>
                  <td className="text-dim source-cell">{r.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <SignalDetail signal={selected} onClose={() => setSelected(null)} />}
    </section>
  )
}

// ─── Analysis Explorer page ───────────────────────────────────────────────────

function ExplorerPage({ initialResult, onBack, modelName }) {
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
          <span style={{ fontSize: 12 }}>Or open a saved analysis from the History panel on the Dashboard.</span>
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

function EduSection({ title, badge, children, defaultOpen = false }) {
  return (
    <details className="edu-section" open={defaultOpen}>
      <summary className="edu-summary">
        {badge && <span className="section-badge">{badge}</span>}
        <span className="edu-summary-title">{title}</span>
      </summary>
      <div className="edu-section-body">{children}</div>
    </details>
  )
}

function EducationPage() {
  return (
    <div className="education-page">
      <div className="edu-header">
        <h1 className="edu-title">📚 How it works</h1>
        <p className="edu-subtitle">
          A plain-English guide to the system: what data it fetches, what each indicator
          measures, how it detects opportunities, and what the trading terms mean.
        </p>
      </div>

      {/* Section 1 — Pipeline */}
      <EduSection title="The analysis pipeline" badge="Pipeline" defaultOpen={true}>
        <p className="section-desc">
          Every analysis — whether triggered by the scheduler or an ad-hoc run — flows
          through the same six steps:
        </p>
        <ol className="edu-steps">
          <li>
            <strong>yfinance</strong> — fetches live price, volume, day change, fundamentals
            (name, sector, P/E, market cap) and 20-day averages. Free, no API key.
          </li>
          <li>
            <strong>tradingview-ta</strong> — fetches RSI, MACD, EMA 20/50/200, Bollinger
            Bands and Stochastic across three timeframes (1H, 4H, 1D) in one call. Free,
            no account needed.
          </li>
          <li>
            <strong>Local Ollama AI</strong> — all indicator data is assembled into a
            structured prompt and sent to the local model (default: <code>qwen2.5:14b</code>).
            Nothing leaves your machine. The model returns a JSON object with trend, momentum,
            signals, risk factors, support/resistance levels, and a confidence score.
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
      <EduSection title="Technical indicators explained" badge="Indicators">
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

      {/* Section 3 — Opportunity detection rules */}
      <EduSection title="How opportunities are detected" badge="Rules">
        <p className="section-desc">
          After the AI analysis runs, four independent rule-based checks are applied to the
          same market data. Any check that fires creates a candidate signal. Candidates for the
          same ticker are merged and their confidence scores are combined.
        </p>

        <div className="edu-rules">
          <div className="edu-rule">
            <div className="edu-rule-num">1</div>
            <div className="edu-rule-body">
              <div className="edu-rule-title">AI signal</div>
              <p>
                The local model returns a <code>long</code> or <code>short</code> direction with
                a confidence value. If confidence ≥ the floor (default: 65), a candidate is
                raised with the AI's entry, stop and target suggestions.
              </p>
            </div>
          </div>
          <div className="edu-rule">
            <div className="edu-rule-num">2</div>
            <div className="edu-rule-body">
              <div className="edu-rule-title">RSI extreme (multi-timeframe)</div>
              <p>
                RSI oversold (&lt;30 = potential long) or overbought (&gt;70 = potential short)
                on <strong>2 or more</strong> of the 1H / 4H / 1D timeframes simultaneously.
                Single-timeframe RSI extremes are ignored — they are too common to be
                meaningful on their own.
              </p>
            </div>
          </div>
          <div className="edu-rule">
            <div className="edu-rule-num">3</div>
            <div className="edu-rule-body">
              <div className="edu-rule-title">MACD crossover (cross-timeframe)</div>
              <p>
                MACD above its signal line on <strong>both</strong> 1D and 4H = bullish
                crossover candidate. MACD below on both = bearish. Requiring both timeframes
                filters out noisy intra-day whipsaws.
              </p>
            </div>
          </div>
          <div className="edu-rule">
            <div className="edu-rule-num">4</div>
            <div className="edu-rule-body">
              <div className="edu-rule-title">Volume spike + significant move</div>
              <p>
                Volume ≥ <code>VOLUME_SPIKE_MULTIPLIER</code>× 20-day average <em>and</em> the
                day's price move ≥ <code>SIGNIFICANT_MOVE_PCT</code>% (both set in{' '}
                <code>.env</code>). A large move on high volume is more likely to be
                sustained than one on thin volume.
              </p>
            </div>
          </div>
        </div>

        <p className="section-desc" style={{ marginTop: 12 }}>
          When multiple rules fire for the same ticker, signals are merged: the type (long/short)
          is determined by majority vote, and the confidence score is boosted by each additional
          agreeing rule. The final score must still clear the confidence floor to be actionable.
        </p>
      </EduSection>

      {/* Section 4 — Glossary */}
      <EduSection title="Trading glossary" badge="Glossary">
        <p className="section-desc">
          Quick reference for terms used throughout the app.
        </p>
        <table className="edu-glossary-table">
          <tbody>
            {[
              ['Bearish',         'Expecting price to fall. A bearish signal suggests a potential short opportunity.'],
              ['Bullish',         'Expecting price to rise. A bullish signal suggests a potential long opportunity.'],
              ['Confidence',      '0–100 score combining AI confidence and rule-based evidence. Higher = stronger agreement across sources.'],
              ['Confidence floor','Minimum confidence to be considered actionable (default: 65). Filters out weak / uncertain signals.'],
              ['Death Cross',     'EMA 50 crossing below EMA 200 — a long-term bearish signal that often attracts institutional selling.'],
              ['Entry',           'Suggested price at which to open the position. Typically near the current price at signal time.'],
              ['Golden Cross',    'EMA 50 crossing above EMA 200 — a long-term bullish signal widely watched by institutional traders.'],
              ['Long',            'Buying a security expecting its price to rise. Profit = price at exit − price at entry.'],
              ['OHLCV',           'Open, High, Low, Close, Volume — the five values in a price candle. Every bar on a chart encodes these.'],
              ['R-multiple',      '(Target − Entry) ÷ (Entry − Stop). A 2R trade means your potential profit is twice your risk. Aim for ≥ 2R.'],
              ['Resistance',      'A price level where selling pressure has historically been strong — like a ceiling the price struggles to break through.'],
              ['Short',           'Selling a security you don\'t own (borrowing it) expecting its price to fall. Profit = price at entry − price at exit.'],
              ['Stop',            'The price at which to exit if the trade goes wrong. Caps your loss. Set it at a technically significant level (e.g. below support).'],
              ['Support',         'A price level where buying interest has historically been strong — like a floor the price bounces off.'],
              ['Target',          'The price goal if the trade goes your way. Sets your reward level for the R-multiple calculation.'],
              ['Timeframe',       '1H = each candle covers 1 hour. 4H = 4 hours. 1D = one full trading day. Longer timeframes filter more noise.'],
              ['Trend',           'Sustained directional movement. Uptrend: higher highs and higher lows. Downtrend: lower highs and lower lows. Sideways: neither.'],
              ['Volume spike',    'Unusually high volume (> 1.5× average). Often triggered by news, earnings surprises, or institutional order flow.'],
            ].map(([term, def]) => (
              <tr key={term}>
                <td className="gls-term">{term}</td>
                <td className="gls-def">{def}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </EduSection>

      {/* Section 5 — Disclaimer + further reading */}
      <EduSection title="Disclaimer & further reading" badge="⚠️">
        <div className="edu-disclaimer">
          <strong>⚠ Not financial advice.</strong> This system is for educational and research
          purposes only. It does not constitute financial, investment, or trading advice.
          All signals are generated by a local AI model and rule-based heuristics — they are
          not predictions and may be wrong. Markets are inherently risky. You are solely
          responsible for any decisions you make. Never trade money you cannot afford to lose.
        </div>
        <p className="section-desc" style={{ marginTop: 12 }}>
          Want to go deeper? These free resources explain the indicators used here:
        </p>
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
      </EduSection>
    </div>
  )
}

// ─── Analysis history panel ──────────────────────────────────────────────────

function AnalysisHistoryPanel({ onOpenInExplorer }) {
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    fetch(`${API}/analysis?limit=25`)
      .then(r => r.json())
      .then(data => { setHistory(data.history ?? []); setLoading(false) })
      .catch(e  => { setErr(e.message); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  const open = (row) => {
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

  return (
    <section className="card">
      <div className="card-title">
        Analysis History
        <button className="btn-ghost" onClick={load} style={{ fontSize: 11, padding: '1px 8px' }}>↺ Refresh</button>
      </div>
      {loading && <div className="empty">Loading…</div>}
      {err    && <div className="error-msg">Could not load history: {err}</div>}
      {history && history.length === 0 && (
        <div className="empty">No analyses yet — run your first analysis above.</div>
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
              </tr>
            </thead>
            <tbody>
              {history.map(row => {
                const aj   = row.analysis_json ?? {}
                const trend = aj.trend ?? '—'
                const conf  = aj.confidence
                return (
                  <tr key={row.id}>
                    <td><span className="badge-ticker">{row.ticker}</span></td>
                    <td><span className={`rbadge trend-${trend}`}>{trend}</span></td>
                    <td>{conf != null ? `${conf}%` : '—'}</td>
                    <td className="ts">{fmtTime(row.created_at)}</td>
                    <td>
                      <button className="btn-open-history" onClick={() => open(row)}>
                        Open in Explorer →
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
        <div style={{ display: activeView === 'dashboard' ? '' : 'none' }}>
          <div className="top-grid">
            <WatchlistCard wl={wl} onWatchlistChange={reloadWatchlist} />
            <AnalyzePanel onExplore={openExplorer} />
          </div>
          <SignalsTable signals={signals} reload={reloadSignals} />
          <AnalysisHistoryPanel onOpenInExplorer={openExplorer} />
        </div>
        <div style={{ display: activeView === 'explorer' ? '' : 'none' }}>
          <ExplorerPage
            key={explorerKey}
            initialResult={explorerState}
            onBack={() => setActiveView('dashboard')}
            modelName={health?.ollama_model}
          />
        </div>
        {activeView === 'education' && <EducationPage />}
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
