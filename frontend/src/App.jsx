import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import {
  ResponsiveContainer,
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine,
  AreaChart, Area, CartesianGrid,
  PieChart, Pie, Legend,
  LineChart, Line,
} from 'recharts'

const API = import.meta.env.VITE_API_URL ?? '/api'

/** Return auth headers for every API call. Reads from sessionStorage so it is
 *  always current without needing React state. */
function getAuthHeaders() {
  const token = sessionStorage.getItem('admin_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Called whenever the backend returns HTTP 401.
 *  Clears the stored token and fires a DOM event so App re-renders the login screen. */
function signal401() {
  sessionStorage.removeItem('admin_token')
  window.dispatchEvent(new CustomEvent('auth-expired'))
}

// ─── SSE stream reader ────────────────────────────────────────────────────────
// Reads a POST SSE stream and yields parsed JSON payloads.
// EventSource only supports GET, so we use fetch + ReadableStream.

async function* readSSEStream(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 401) { if (sessionStorage.getItem('admin_token')) signal401(); throw new Error('Unauthorized') }
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
  { id: 'fetch',   label: 'Fetch market data',   status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
  { id: 'analyze', label: 'AI analysis',          status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
  { id: 'detect',  label: 'Detect opportunities', status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
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
      const SKILL_TO_STEP = { fetch_data: 'fetch', ai_analysis: 'analyze', opportunity_detect: 'detect' }
      for await (const evt of readSSEStream(`${API}/analyze/stream`, { ticker: t, send_alerts: false })) {
        if (evt.type === 'step') {
          setSteps(prev => prev.map(s =>
            s.id === evt.step
              ? {
                  ...s,
                  status: evt.status,
                  elapsed: evt.elapsed_ms != null ? (evt.elapsed_ms / 1000).toFixed(1) : s.elapsed,
                  msg: evt.msg ?? s.msg,
                  startedAt: evt.status === 'running' ? Date.now() : null,
                }
              : s
          ))
        } else if (evt.type === 'retry') {
          const stepId = SKILL_TO_STEP[evt.skill] ?? evt.skill
          setSteps(prev => prev.map(s =>
            s.id === stepId ? { ...s, retries: (s.retries || 0) + 1 } : s
          ))
        } else if (evt.type === 'result') {
          setResult(evt)
          // Backfill the detect step with scored opportunities and the analyze step
          // with the model that actually ran — no extra SSE event needed.
          setSteps(prev => prev && prev.map(s => {
            if (s.id === 'detect' && evt.opportunities?.length) {
              return { ...s, opportunities: evt.opportunities, actionable: evt.actionable ?? [] }
            }
            if (s.id === 'analyze' && evt.analysis) {
              return {
                ...s,
                llm_model:    evt.analysis.llm_model    ?? null,
                llm_provider: evt.analysis.llm_provider ?? null,
              }
            }
            return s
          }))
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

  // Tick elapsed display for any step that is currently running.
  useEffect(() => {
    if (!streaming || !steps) return
    const hasRunning = steps.some(s => s.status === 'running' && s.startedAt)
    if (!hasRunning) return
    const id = setInterval(() => {
      setSteps(prev => prev && prev.map(s =>
        s.status === 'running' && s.startedAt
          ? { ...s, elapsed: ((Date.now() - s.startedAt) / 1000).toFixed(1) }
          : s
      ))
    }, 200)
    return () => clearInterval(id)
  }, [streaming, steps])

  return { streaming, steps, result, error, run }
}

// ─── Polling hook ─────────────────────────────────────────────────────────────

function usePolling(path, intervalMs = 0) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(API + path, { headers: getAuthHeaders() })
      // Only force re-login if we actually had a token — prevents stale pre-login
      // requests from wiping a token the user set while the request was in-flight.
      if (res.status === 401) { if (sessionStorage.getItem('admin_token')) signal401(); return }
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
    subs: [
      'Backend pre-computes long/short candidate trade plans (ATR-based)',
      'Build structured prompt with all market context + candidate plans',
      'Call configured LLM (Ollama · Groq · Gemini · Mistral)',
      'LLM classifies setup & selects a plan_id — no price calculation',
      'Parse v2 response: decision, confidence_raw, evidence, risks',
    ],
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
                {step.id === 'analyze' && step.status === 'done' && step.llm_model && (
                  <span
                    className="model-chip step-model-chip"
                    title={step.llm_provider ? `${step.llm_provider} · ${step.llm_model}` : step.llm_model}
                  >
                    {step.llm_provider ? `${step.llm_provider} · ` : ''}{step.llm_model}
                  </span>
                )}
                {step.elapsed != null && (
                  <span className={`step-elapsed${step.status === 'running' ? ' step-elapsed-live' : ''}`}>
                    {step.elapsed}s{step.status === 'running' ? '…' : ''}
                  </span>
                )}
                {step.retries > 0 && (
                  <span className="step-retry-badge">↺ {step.retries}</span>
                )}
                <span className={`step-badge step-badge-${step.status}`}>
                  {step.status === 'done'    ? '✓ done'
                 : step.status === 'running' ? '⟳ running'
                 : step.status === 'error'   ? '✕ error'
                 :                             'pending'}
                </span>
              </div>
              <ul className={`step-subs${step.status === 'pending' ? ' step-subs-pending' : ''}`}>
                {meta.subs.map(s => <li key={s}>{s}</li>)}
              </ul>
              {/* Scored opportunities — summary pills; full breakdown in Score Computation section */}
              {step.id === 'detect' && step.status === 'done' && step.opportunities !== null && step.opportunities?.length > 0 && (
                <div className="step-opp-pills">
                  {[...step.opportunities]
                    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
                    .map((opp, i) => {
                      const isActionable = (step.actionable ?? []).some(
                        a => a.type === opp.type && Math.abs((a.confidence ?? 0) - (opp.confidence ?? 0)) < 0.5
                      )
                      return (
                        <span key={i} className={`opp-pill ${isActionable ? 'opp-pill-ok' : 'opp-pill-sub'}`}>
                          <span className={`opp-pill-type ${opp.type}`}>{opp.type?.toUpperCase() ?? '—'}</span>
                          <span className="opp-pill-conf">{(opp.confidence ?? 0).toFixed(0)}%</span>
                          <span className="opp-pill-src">{opp.source ?? (opp.sources ?? []).join('+') ?? ''}</span>
                          <span className="opp-pill-status">{isActionable ? '✓' : '↓'}</span>
                        </span>
                      )
                    })
                  }
                </div>
              )}
              {step.id === 'detect' && step.status === 'done' && step.opportunities !== null && !step.opportunities?.length && (
                <div className="step-opp-none">no rule checks fired</div>
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
      const res = await fetch(`${API}/market-data/${ticker}/history`, { headers: getAuthHeaders() })
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

function fmtTokens(n) {
  if (n == null || n === 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function Header({ health, usage, btTodayTokens = 0, activeView, onViewChange, clock }) {
  const ok   = health?.status === 'ok'
  const open = health?.scheduler?.market_open

  // Countdown helper shared with the header market pill
  const fmtCountdown = (isoStr) => {
    if (!isoStr) return null
    const diffMs = new Date(isoStr) - Date.now()
    if (diffMs <= 0) return null
    const totalMin = Math.floor(diffMs / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  const closeIn = clock?.is_open  && clock?.next_close ? fmtCountdown(clock.next_close) : null
  const openIn  = !clock?.is_open && clock?.next_open  ? fmtCountdown(clock.next_open)  : null

  // Model label — provider + model from /health
  const provider  = health?.llm_provider ?? null
  const modelName = health?.llm_model    ?? health?.ollama_model ?? null
  const modelLabel = provider && provider !== 'ollama'
    ? `${provider} · ${modelName ?? '—'}`
    : (modelName ?? null)

  // Token label — filter to the active provider+model so the chip reflects
  // usage for the currently selected model only, not all providers combined.
  const today = new Date().toISOString().slice(0, 10)
  const activeProvider = usage?.active_provider ?? null
  const activeModel    = usage?.active_model    ?? null
  // by_model_day rows: { day, provider, model, prompt_tokens, completion_tokens }
  const modelTodayTokens = (() => {
    if (!usage?.by_model_day) {
      // fallback: use the combined by_day total
      return usage?.by_day?.find(d => d.date === today)?.total_tokens ?? 0
    }
    return (usage.by_model_day
      .filter(r =>
        r.day === today &&
        (!activeProvider || r.provider === activeProvider) &&
        (!activeModel    || r.model    === activeModel)
      )
      .reduce((s, r) => s + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0), 0)
    )
  })()
  // by_model_day already includes backtest + signal + advisor + compare tokens
  // (the /usage endpoint UNIONs all sources). Do NOT add btTodayTokens here —
  // that would double-count backtest runs that are already in modelTodayTokens.
  const todayTokens = modelTodayTokens
  // For tooltip: all-providers combined today total
  const todayEntry = usage?.by_day?.find(d => d.date === today)

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
            className={`nav-tab ${activeView === 'paper' ? 'active' : ''}`}
            onClick={() => onViewChange('paper')}
          >
            Trading
          </button>
          <button
            className={`nav-tab ${activeView === 'education' ? 'active' : ''}`}
            onClick={() => onViewChange('education')}
          >
            Learn
          </button>
        </nav>

        {/* Live status chips — API · Market · Model · Tokens */}
        <div className="header-live-chips">
          {!health && (
            <span className="live-chip live-chip-connecting">connecting…</span>
          )}
          {health && (
            <span
              className={`live-chip live-chip-api ${ok ? 'live-chip-api-ok' : 'live-chip-api-err'}`}
              title={ok ? 'Backend API is healthy' : 'Backend API error'}
            >
              {ok ? '✅ API' : '⚠️ API Error'}
            </span>
          )}
          {health && (
            <span
              className={`live-chip ${open ? 'live-chip-market-open' : 'live-chip-market-closed'}`}
              title={open
                ? (closeIn ? `Closes in ${closeIn}` : 'US equity market is currently open')
                : (openIn  ? `Opens in ${openIn}`   : 'US equity market is currently closed')}
            >
              {open ? '🟢 US Market Open' : '🔴 US Market Closed'}
              {open  && closeIn && <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 5 }}>· closes in {closeIn}</span>}
              {!open && openIn  && <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 5 }}>· opens in {openIn}</span>}
            </span>
          )}
          {health && modelLabel && (
            <span className="live-chip live-chip-model" title={`Active LLM: ${modelLabel}`}>
              🧠 {modelLabel}
            </span>
          )}
          {health && usage && (
            <span
              className="live-chip live-chip-tokens"
              title={[
                `Tokens today (${activeModel ? activeModel.split('/').pop() : 'all models'}): ${todayTokens.toLocaleString()}`,
                `  analysis: ${fmtTokens(modelTodayTokens)}  backtests: ${fmtTokens(btTodayTokens)}`,
                `All providers today: ${fmtTokens(todayEntry?.total_tokens ?? 0)}`,
                `All-time (${usage?.period_days ?? 30}d): ${fmtTokens(usage?.total_prompt_tokens ?? 0)} prompt + ${fmtTokens(usage?.total_completion_tokens ?? 0)} completion`,
              ].join('\n')}
            >
              ⚡ {fmtTokens(todayTokens)} tok today
            </span>
          )}
        </div>
      </div>
      <div className="header-right">
        <div className="header-tools">
          <button
            className={`nav-tab ${activeView === 'backtest' ? 'active' : ''}`}
            onClick={() => onViewChange('backtest')}
            style={{ fontSize: 12 }}
          >
            Backtesting
          </button>
          <a href="http://localhost:18889" target="_blank" rel="noreferrer" className="tool-btn" title="Aspire — traces & logs">Logs</a>
          <a href="http://localhost:9000"  target="_blank" rel="noreferrer" className="tool-btn" title="Portainer — container management">Portainer</a>
          <button
            className={`tool-btn ${activeView === 'settings' ? 'tool-btn-active' : ''}`}
            onClick={() => onViewChange('settings')}
            title="Settings"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '3px 8px' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.69.07-1.08s-.03-.74-.07-1.08l2.33-1.82c.21-.17.27-.46.14-.7l-2.2-3.82c-.14-.24-.42-.32-.66-.24l-2.74 1.1c-.57-.44-1.18-.8-1.84-1.08l-.42-2.9c-.04-.26-.27-.46-.54-.46H9.5c-.27 0-.5.2-.54.46l-.42 2.9c-.66.28-1.27.64-1.84 1.08l-2.74-1.1c-.24-.08-.52 0-.66.24l-2.2 3.82c-.14.24-.07.53.14.7L3.57 10c-.04.34-.07.69-.07 1.08s.03.74.07 1.08L1.24 13.98c-.21.17-.27.46-.14.7l2.2 3.82c.14.24.42.32.66.24l2.74-1.1c.57.44 1.18.8 1.84 1.08l.42 2.9c.04.26.27.46.54.46h4.4c.27 0 .5-.2.54-.46l.42-2.9c.66-.28 1.27-.64 1.84-1.08l2.74 1.1c.24.08.52 0 .66-.24l2.2-3.82c.14-.24.07-.53-.14-.7l-2.33-1.9z"/>
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}

// ─── Watchlist card ───────────────────────────────────────────────────────────

function WatchlistCard({ wl, onWatchlistChange, signals }) {
  const [newTicker,  setNewTicker]  = useState('')
  const [adding,     setAdding]     = useState(false)
  const [snapshots,  setSnapshots]  = useState({})   // ticker → normalised snapshot
  const [snapError,  setSnapError]  = useState(false)
  const [snapLoading,setSnapLoading]= useState(false)

  const tickers    = wl?.watchlist ?? []
  const marketOpen = wl?.scheduler?.market_open ?? false

  const loadSnapshots = useCallback(async () => {
    if (!tickers.length) return
    setSnapLoading(true)
    try {
      const r = await fetch(`${API}/paper/market/snapshots?symbols=${tickers.join(',')}`, { headers: getAuthHeaders() })
      if (!r.ok) throw new Error()
      const d = await r.json()
      setSnapshots(d.snapshots ?? {})
      setSnapError(false)
    } catch {
      setSnapError(true)
    } finally {
      setSnapLoading(false)
    }
  }, [tickers.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Always fetch once on mount so last-session prices are visible even when closed.
    loadSnapshots()
    // Only poll every 30 s during market hours — no point hitting Alpaca when closed.
    if (!marketOpen) return
    const id = setInterval(loadSnapshots, 30_000)
    return () => clearInterval(id)
  }, [loadSnapshots, marketOpen])

  if (!wl) return <div className="card skeleton" style={{ minHeight: 100 }} />

  const scheduler = wl.scheduler
  // Prefer the scheduler's live DB value; fall back to the env-default top-level field
  const scan_interval_minutes = scheduler?.scan_interval_minutes ?? wl.scan_interval_minutes

  const addTicker = async () => {
    const t = newTicker.trim().toUpperCase()
    if (!t) return
    setAdding(true)
    try {
      await fetch(`${API}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ ticker: t }),
      })
      setNewTicker('')
      onWatchlistChange()
    } finally {
      setAdding(false)
    }
  }

  const removeTicker = async (ticker) => {
    await fetch(`${API}/watchlist/${ticker}`, { method: 'DELETE', headers: getAuthHeaders() })
    onWatchlistChange()
  }

  const fmtPrice  = (v) => v == null ? '—' : `$${parseFloat(v).toFixed(2)}`
  const fmtVol    = (v) => {
    if (v == null) return '—'
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`
    return String(v)
  }
  const fmtAgo = (iso) => {
    if (!iso) return '—'
    const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
    if (secs < 60)   return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const hasLiveData = Object.keys(snapshots).length > 0

  return (
    <section className="card">
      <div className="card-title">
        Watchlist
        <span className="card-sub">scan every {scan_interval_minutes}m</span>
        <span className={`scheduler-status-chip ${scheduler?.running ? 'running' : 'stopped'}`}>
          {scheduler?.running ? '● scanning' : '○ paused'}
        </span>
        {!snapError && snapLoading && <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 6 }}>↻</span>}
        {snapError && <span style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 6 }}>· no live prices</span>}
        {!marketOpen && hasLiveData && (
          <span style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 8, fontStyle: 'italic' }}>
            prices from last session
          </span>
        )}
      </div>

      {/* Live market data table */}
      {hasLiveData ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left',  padding: '4px 8px', color: 'var(--dim)', fontWeight: 500, fontSize: 11 }}>Ticker</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--dim)', fontWeight: 500, fontSize: 11 }}>Price</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--dim)', fontWeight: 500, fontSize: 11 }}>Chg%</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--dim)', fontWeight: 500, fontSize: 11 }}>VWAP</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--dim)', fontWeight: 500, fontSize: 11 }}>Vol</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--dim)', fontWeight: 500, fontSize: 11 }}>H/L</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--dim)', fontWeight: 500, fontSize: 11 }}>Last</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {tickers.map((t) => {
                const s = snapshots[t]
                const chg = s?.day_chg_pct
                const chgColor = chg == null ? 'var(--dim)' : chg >= 0 ? 'var(--green)' : 'var(--red)'
                return (
                  <tr key={t} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 40%, transparent)' }}>
                    <td style={{ padding: '5px 8px', fontWeight: 700 }}>{t}</td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtPrice(s?.price)}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', color: chgColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {chg == null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtPrice(s?.vwap)}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtVol(s?.volume)}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 11, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {s ? `${fmtPrice(s.high)} / ${fmtPrice(s.low)}` : '—'}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
                      {fmtAgo(s?.last_trade_at)}
                    </td>
                    <td style={{ padding: '5px 4px', textAlign: 'right' }}>
                      <button className="chip-remove" onClick={() => removeTicker(t)} title={`Remove ${t}`}>×</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* Fallback: plain chips when Alpaca not configured */
        <div className="chip-row">
          {tickers.map((t) => (
            <span key={t} className="chip">
              {t}
              <button className="chip-remove" onClick={() => removeTicker(t)} title={`Remove ${t}`}>×</button>
            </span>
          ))}
        </div>
      )}

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
      {/* Last signal detection timestamp */}
      {(() => {
        const rows = signals?.signals ?? []
        const latest = rows[0]
        if (!latest?.created_at) return null
        return (
          <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>🔔 Last signal:</span>
            <span title={latest.created_at} style={{ color: 'var(--fg)' }}>
              {new Date(latest.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            <span>·</span>
            <span style={{ color: 'var(--fg)' }}>{latest.ticker}</span>
            <span>·</span>
            <span style={{ color: latest.type === 'long' ? 'var(--green)' : 'var(--red)' }}>{latest.type}</span>
            <span>·</span>
            <span>{latest.confidence}% conf</span>
          </div>
        )
      })()}
    </section>
  )
}

// ─── LLM Reasoning ───────────────────────────────────────────────────────────

const CONF_BAND_COLOR = {
  very_low: 'var(--red)', low: 'var(--yellow)', moderate: 'var(--dim)',
  high: 'var(--green)', very_high: 'var(--green)',
}
const EVIDENCE_DIR_COLOR = { bullish: 'var(--green)', bearish: 'var(--red)', neutral: 'var(--dim)' }
const RISK_SEV_COLOR = { low: 'var(--dim)', medium: 'var(--yellow)', high: 'var(--red)' }

function LLMReasoning({ analysis, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!analysis || analysis.error) return null

  const {
    trend, momentum, signals = [], risk_factors = [], key_levels = {},
    // v2 extra fields
    confidence_band, reason_code, data_quality, evidence = [], risks = [], summary,
  } = analysis
  const support    = key_levels?.support    ?? []
  const resistance = key_levels?.resistance ?? []
  const isV2 = !!analysis.schema_version  // true when LLM returned v2 schema

  return (
    <div className="reasoning-box">
      <button className="reasoning-toggle" onClick={() => setOpen(o => !o)}>
        <span className="reasoning-toggle-label">LLM Reasoning</span>
        <span className="reasoning-badges-inline">
          {trend    && <span className={`rbadge trend-${trend}`}>trend: {trend}</span>}
          {momentum && <span className="rbadge momentum">momentum: {momentum}</span>}
          {confidence_band && (
            <span className="rbadge" style={{ color: CONF_BAND_COLOR[confidence_band] || 'var(--dim)', borderColor: CONF_BAND_COLOR[confidence_band] }}>
              confidence: {confidence_band.replace(/_/g, ' ')}
            </span>
          )}
          {reason_code && (
            <span className="rbadge" style={{
              color: reason_code === 'aligned_setup' ? 'var(--green)'
                : reason_code === 'weak_edge' || reason_code === 'conflicting_timeframes' ? 'var(--yellow)'
                : 'var(--dim)',
              fontSize: 10,
            }}>
              {reason_code.replace(/_/g, ' ')}
            </span>
          )}
          {data_quality?.grade && (
            <span className="rbadge" style={{
              color: data_quality.grade === 'good' ? 'var(--green)'
                : data_quality.grade === 'poor' ? 'var(--red)' : 'var(--dim)',
              fontSize: 10,
            }}>
              data: {data_quality.grade}
            </span>
          )}
        </span>
        <span className="reasoning-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="reasoning-body">
          {/* v2: summary line */}
          {summary && (
            <div className="reasoning-section">
              <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text)', margin: 0 }}>{summary}</p>
            </div>
          )}
          {/* v2 evidence with direction/strength; fallback to plain signals list */}
          {(isV2 ? evidence : signals).length > 0 && (
            <div className="reasoning-section">
              <div className="reasoning-label">Evidence</div>
              {isV2 ? (
                <ul className="reasoning-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                  {evidence.map((e, i) => (
                    <li key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, minWidth: 52, paddingTop: 1,
                        color: EVIDENCE_DIR_COLOR[e.direction] || 'var(--dim)' }}>
                        {(e.direction || '').toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13 }}>{e.observation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="reasoning-list">
                  {signals.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              )}
            </div>
          )}
          {/* v2 risks with severity; fallback to plain risk_factors */}
          {(isV2 ? risks : risk_factors).length > 0 && (
            <div className="reasoning-section">
              <div className="reasoning-label risk">Risk Factors</div>
              {isV2 ? (
                <ul className="reasoning-list risk" style={{ listStyle: 'none', paddingLeft: 0 }}>
                  {risks.map((r, i) => (
                    <li key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, minWidth: 52, paddingTop: 1,
                        color: RISK_SEV_COLOR[r.severity] || 'var(--dim)' }}>
                        {(r.severity || '').toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13 }}>{r.observation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="reasoning-list risk">
                  {risk_factors.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
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
  const [orderStates, setOrderStates] = useState({}) // { index: null|'placing'|'placed'|'exists'|errorStr }

  const placeOrderFromResult = async (opp, idx) => {
    setOrderStates(s => ({ ...s, [idx]: 'placing' }))
    try {
      const res = await fetch(`${API}/paper/orders/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          ticker:             result.ticker,
          side:               opp.type === 'long' ? 'buy' : 'sell',
          entry:              opp.entry ?? opp.price,
          stop:               opp.stop,
          target:             opp.target,
          signal_confidence:  opp.confidence ?? null,
          signal_source:      opp.source ?? (opp.sources ? opp.sources.join('+') : null),
          signal_timestamp:   opp.timestamp ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) setOrderStates(s => ({ ...s, [idx]: data.detail ?? 'Error' }))
      else setOrderStates(s => ({ ...s, [idx]: data.placed ? 'placed' : 'exists' }))
    } catch { setOrderStates(s => ({ ...s, [idx]: 'Error' })) }
  }

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
                <th>Entry</th><th>Stop</th><th>Target</th><th>Source</th><th></th>
              </tr>
            </thead>
            <tbody>
              {actionable.map((opp, i) => {
                const os = orderStates[i]
                const canPlace = opp.stop != null && opp.target != null
                return (
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
                    <td>
                      {canPlace && os !== 'placed' && os !== 'exists' && (
                        <button
                          onClick={() => placeOrderFromResult(opp, i)}
                          disabled={os === 'placing'}
                          style={{
                            fontSize: 10, padding: '2px 8px', borderRadius: 4,
                            cursor: os === 'placing' ? 'wait' : 'pointer',
                            background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                            color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap',
                          }}
                        >
                          {os === 'placing' ? '⏳' : '📈 Place'}
                        </button>
                      )}
                      {os === 'placed'  && <span style={{ fontSize: 10, color: 'var(--green)' }}>✓ Placed</span>}
                      {os === 'exists'  && <span style={{ fontSize: 10, color: 'var(--dim)'   }}>Already exists</span>}
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
    fetch(`${API}/analysis/${signal.ticker}?limit=5`, { headers: getAuthHeaders() })
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

function SignalCard({ r, expanded, onToggle, onDelete, existingOrder = null }) {
  const isLong   = r.type === 'long'
  const conf     = r.confidence ?? 0
  const modelTag = r.llm_model || null
  const [orderState, setOrderState] = useState(null) // null | 'placing' | 'placed' | 'exists' | string(error)

  const placeOrder = async (e) => {
    e.stopPropagation()
    setOrderState('placing')
    try {
      const res = await fetch(`${API}/paper/orders/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          ticker:             r.ticker,
          side:               r.type === 'long' ? 'buy' : 'sell',
          entry:              r.entry ?? r.price,
          stop:               r.stop,
          target:             r.target,
          signal_id:          r.id,
          signal_confidence:  r.confidence ?? null,
          signal_source:      r.source ?? (r.sources ? r.sources.join('+') : null),
          signal_timestamp:   r.timestamp ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) setOrderState(data.detail ?? 'Error')
      else setOrderState(data.placed ? 'placed' : 'exists')
    } catch { setOrderState('Error') }
  }

  // ── R:R context ──────────────────────────────────────────────────────────
  // For a long: risk = entry − stop (positive), reward = target − entry
  // For a short: risk = stop − entry (positive), reward = entry − target
  const entry  = r.entry  ?? r.price
  const stop   = r.stop
  const target = r.target
  const risk   = (entry != null && stop   != null) ? Math.abs(entry - stop)   : null
  const reward = (entry != null && target != null) ? Math.abs(target - entry) : null
  const rr     = (risk && reward && risk > 0) ? (reward / risk) : null
  // For the proportional mini-bar: risk segment width as % of total bracket
  const riskPct = (risk != null && reward != null && (risk + reward) > 0)
    ? Math.round(risk / (risk + reward) * 100) : null

  // ── 52-week range bar ────────────────────────────────────────────────────
  const w52hi  = r.week52_high
  const w52lo  = r.week52_low
  const w52pct = (w52hi != null && w52lo != null && w52hi > w52lo && r.price != null)
    ? Math.round(Math.max(0, Math.min(1, (r.price - w52lo) / (w52hi - w52lo))) * 100)
    : null

  // Tooltip strings for each level cell
  const _noBracket = 'ATR bracket not stored — this was an older signal. New signals include stop & target.'
  const levelMeta = isLong
    ? {
        Price:  'Price at signal time',
        Entry:  'Open the long position here',
        Stop:   stop   != null ? `Cut loss if price drops here (−${fmtN(risk)} risk)` : _noBracket,
        Target: target != null ? `Take profit here (+${fmtN(reward)} reward)`          : _noBracket,
      }
    : {
        Price:  'Price at signal time',
        Entry:  'Open the short position here',
        Stop:   stop   != null ? `Cut loss if price rises here (+${fmtN(risk)} risk)` : _noBracket,
        Target: target != null ? `Take profit here (−${fmtN(reward)} reward)`          : _noBracket,
      }

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

      {/* price grid — color-coded with semantic tooltips */}
      <div className="signal-levels-grid">
        {[
          ['Price',  r.price,  null,            levelMeta.Price],
          ['Entry',  r.entry,  null,            levelMeta.Entry],
          ['Stop',   r.stop,   'var(--red)',    levelMeta.Stop],
          ['Target', r.target, 'var(--green)',  levelMeta.Target],
        ].map(([lbl, val, color, tip]) => (
          <div key={lbl} className="signal-level-cell" title={tip}>
            <span className="signal-level-label">{lbl}</span>
            <span
              className="signal-level-value"
              style={val != null ? (color ? { color } : {}) : { color: 'var(--text-dim)', opacity: 0.45 }}
            >
              {fmtN(val)}
            </span>
          </div>
        ))}
      </div>

      {/* R:R bracket row */}
      {riskPct != null && (
        <div className="signal-rr-row" title={`Risk ${fmtN(risk)} · Reward ${fmtN(reward)} · R:R ${rr?.toFixed(1)}`}>
          <div className="signal-rr-bar">
            <div
              className="signal-rr-risk"
              style={{ width: `${riskPct}%` }}
            />
            <div
              className="signal-rr-reward"
              style={{ width: `${100 - riskPct}%` }}
            />
          </div>
          <div className="signal-rr-labels">
            <span className="signal-rr-risk-lbl">Risk {isLong ? '−' : '+'}{fmtN(risk)}</span>
            {rr != null && <span className="signal-rr-ratio">{rr.toFixed(1)}:1</span>}
            <span className="signal-rr-reward-lbl">Reward {isLong ? '+' : '−'}{fmtN(reward)}</span>
          </div>
        </div>
      )}

      {/* 52-week range bar */}
      {w52pct != null && (
        <div
          className="signal-52w-row"
          title={`52w range: ${fmtN(w52lo)} – ${fmtN(w52hi)} · signal at ${w52pct}% of range`}
        >
          <span className="signal-52w-label">52w</span>
          <div className="signal-52w-wrap">
            <div className="signal-52w-track">
              <div className="signal-52w-fill" style={{ width: `${w52pct}%` }} />
              <div className="signal-52w-dot"  style={{ left: `${w52pct}%` }} />
            </div>
            <div className="signal-52w-caption">
              <span className="signal-52w-pct">{w52pct}%</span>
              <span className="signal-52w-range">{fmtN(w52lo)} – {fmtN(w52hi)}</span>
            </div>
          </div>
        </div>
      )}

      {/* source chips + LLM/Rules badge on the same row */}
      <div className="signal-sources">
        {r.source && r.source.split('+').map(s => (
          <span key={s} className="signal-chip">{SOURCE_LABEL[s.trim()] ?? s.trim()}</span>
        ))}
        <span
          title={r.llm_model ? `AI model: ${r.llm_model}` : 'Signal generated by rule-based engine (no LLM)'}
          style={{
            marginLeft: 'auto',
            fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
            padding: '2px 6px', borderRadius: 4, flexShrink: 0,
            background: r.llm_model
              ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
              : 'color-mix(in srgb, var(--dim) 10%, transparent)',
            color: r.llm_model ? 'var(--accent)' : 'var(--dim)',
            border: `1px solid ${r.llm_model ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--dim) 20%, transparent)'}`,
          }}
        >
          {r.llm_model ? '🤖 LLM' : '📐 Rules'}
        </span>
      </div>

      {/* expanded: LLM reasoning */}
      {expanded && r.llm_analysis && (
        <div className="signal-reasoning">
          <div className="signal-reasoning-label">AI Reasoning</div>
          <div className="signal-reasoning-body">{r.llm_analysis}</div>
        </div>
      )}

      {/* Manual place order — centred, shows existing order status when one exists */}
      {r.stop != null && r.target != null && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {existingOrder && orderState == null ? (
            /* Order already exists — show status as disabled badge */
            <button
              disabled
              title={`Alpaca order: ${existingOrder.alpaca_order_id ?? '—'}`}
              style={{
                fontSize: 11, padding: '3px 12px', borderRadius: 5, cursor: 'default', fontWeight: 600,
                background: 'color-mix(in srgb, var(--dim) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--dim) 25%, transparent)',
                color: 'var(--dim)', opacity: 0.85,
              }}
            >
              📋 {(existingOrder.status ?? 'order placed').replace(/_/g, ' ').toUpperCase()}
            </button>
          ) : (
            <>
              {orderState !== 'placed' && orderState !== 'exists' && (
                <button
                  onClick={placeOrder}
                  disabled={orderState === 'placing'}
                  style={{
                    fontSize: 11, padding: '3px 12px', borderRadius: 5,
                    cursor: orderState === 'placing' ? 'wait' : 'pointer',
                    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                    color: 'var(--accent)', fontWeight: 600,
                  }}
                >
                  {orderState === 'placing' ? '⏳ Placing…' : '📈 Place Paper Order'}
                </button>
              )}
              {orderState === 'placed' && <span style={{ fontSize: 11, color: 'var(--green)' }}>✓ Order placed</span>}
              {orderState === 'exists'  && <span style={{ fontSize: 11, color: 'var(--dim)' }}>ℹ Order already exists</span>}
              {orderState && !['placing','placed','exists'].includes(orderState) && (
                <span style={{ fontSize: 11, color: 'var(--red)' }}>✗ {orderState}</span>
              )}
            </>
          )}
        </div>
      )}

    </div>
  )
}

function SignalsTable({ signals, reload, signalOrderMap = {} }) {
  const [open,         setOpen]         = useState(false)
  const [filterSide,     setFilterSide]     = useState('all')
  const [filterConf,     setFilterConf]     = useState(null)   // null = data min (no filter)
  const [filterMaxPrice, setFilterMaxPrice] = useState(null)   // null = data max (no filter)
  const [filterTicker,   setFilterTicker]   = useState('')
  const [expanded,       setExpanded]       = useState(null)

  if (!signals) return <div className="card skeleton" style={{ minHeight: 80 }} />

  const allRows = signals.signals ?? []

  // Derive actual boundaries from stored signals
  const confs  = allRows.map(r => r.confidence ?? 0)
  const prices = allRows.map(r => r.price ?? r.entry ?? 0).filter(p => p > 0)
  const dataConfMin  = confs.length  ? Math.floor(Math.min(...confs)  / 5)  * 5  : 0
  const dataConfMax  = confs.length  ? Math.ceil(Math.max(...confs)   / 5)  * 5  : 100
  const dataPriceMin = prices.length ? Math.floor(Math.min(...prices) / 10) * 10 : 0
  const dataPriceMax = prices.length ? Math.ceil(Math.max(...prices)  / 10) * 10 : 1000
  const activeConf     = filterConf     ?? dataConfMin   // floor: hide below this
  const activeMaxPrice = filterMaxPrice ?? dataPriceMax  // ceiling: hide above this

  const rows = allRows.filter(r => {
    if (filterSide !== 'all' && r.type !== filterSide) return false
    if ((r.confidence ?? 0) < activeConf) return false
    if (filterTicker && !r.ticker?.includes(filterTicker.toUpperCase())) return false
    const p = r.price ?? r.entry ?? 0
    if (p > activeMaxPrice) return false
    return true
  })

  const handleDelete = async (id) => {
    if (!confirm('Delete this signal?')) return
    await fetch(`${API}/signals/${id}`, { method: 'DELETE', headers: getAuthHeaders() }).catch(() => {})
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
              type="range" min={dataConfMin} max={dataConfMax} step={1}
              value={activeConf}
              onChange={e => {
                const v = Number(e.target.value)
                setFilterConf(v <= dataConfMin ? null : v)
              }}
              className="filter-range"
            />
            <span className="filter-val">{activeConf}%</span>
          </div>

          <div className="filter-group">
            <label className="filter-label">Max price</label>
            <input
              type="range" min={dataPriceMin} max={dataPriceMax} step={10}
              value={activeMaxPrice}
              onChange={e => {
                const v = Number(e.target.value)
                setFilterMaxPrice(v >= dataPriceMax ? null : v)
              }}
              className="filter-range"
            />
            <span className="filter-val">${activeMaxPrice}</span>
          </div>

          {/* Ticker + Clear always grouped together on the right */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="text"
              placeholder="Ticker…"
              value={filterTicker}
              onChange={e => setFilterTicker(e.target.value)}
              className="filter-ticker-input"
            />
            {(filterSide !== 'all' || filterConf !== null || filterMaxPrice !== null || filterTicker) && (
              <button
                className="btn-ghost"
                style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={() => { setFilterSide('all'); setFilterConf(null); setFilterMaxPrice(null); setFilterTicker('') }}
              >
                Clear filters
              </button>
            )}
          </div>
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
              existingOrder={signalOrderMap[r.id] ?? null}
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

// ─── Analysis history panel ──────────────────────────────────────────────────

function AnalysisHistoryPanel({ onOpenInExplorer, expanded: extExpanded, onToggleExpanded }) {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded    = extExpanded !== undefined ? extExpanded : localExpanded
  const setExpanded = onToggleExpanded ? (v) => onToggleExpanded(typeof v === 'function' ? v(expanded) : v)
                                       : setLocalExpanded
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    fetch(`${API}/analysis?limit=25`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(data => { setHistory(data.history ?? []); setLoading(false) })
      .catch(e  => { setErr(e.message); setLoading(false) })
  }, [])

  // Load data the first time the panel is opened
  useEffect(() => { if (expanded && history === null) load() }, [expanded, history, load])

  const openRow = (row) => {
    // row.opportunities / row.actionable are null for entries recorded before
    // the opportunities columns were added; the stepper shows a friendly
    // "not stored" message in that case rather than "no rule checks fired".
    onOpenInExplorer({
      ticker:        row.ticker,
      analysis:      row.analysis_json,
      market_data:   row.market_snapshot,
      opportunities: row.opportunities,    // null | Opportunity[]
      actionable:    row.actionable ?? [], // null → []
      errors:        [],
      _from_history: true,
      _history_at:   row.created_at,
    })
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this analysis entry?')) return
    await fetch(`${API}/analysis/${id}`, { method: 'DELETE', headers: getAuthHeaders() }).catch(() => {})
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
                    <th>Mode</th>
                    <th>Run at</th>
                    <th></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(row => {
                    const aj      = row.analysis_json ?? {}
                    // When LLM is disabled, analysis_json.trend / .opportunity are null;
                    // fall back to the rule-based opportunities stored alongside the record.
                    const bestOpp = (row.opportunities ?? [])
                      .slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
                    const rawTrend = aj.trend
                    const trend    = rawTrend && rawTrend !== 'neutral'
                      ? rawTrend
                      : bestOpp?.type === 'long'  ? 'bullish'
                      : bestOpp?.type === 'short' ? 'bearish'
                      : rawTrend ?? '—'
                    const conf = aj.opportunity?.confidence ?? bestOpp?.confidence
                    return (
                      <tr key={row.id}>
                        <td><span className="badge-ticker">{row.ticker}</span></td>
                        <td><span className={`rbadge trend-${trend}`}>{trend}</span></td>
                        <td>{conf != null && conf > 0 ? `${conf.toFixed(0)}%` : '—'}</td>
                        <td>
                          <span
                            title={row.llm_model ? `Model: ${row.llm_model}` : 'Rule-based engine — LLM was disabled'}
                            style={{
                              fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
                              textTransform: 'uppercase', padding: '2px 5px', borderRadius: 4,
                              background: row.llm_provider
                                ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                                : 'color-mix(in srgb, var(--dim) 10%, transparent)',
                              color: row.llm_provider ? 'var(--accent)' : 'var(--dim)',
                              border: `1px solid ${row.llm_provider ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--dim) 20%, transparent)'}`,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {row.llm_provider ? '🤖 LLM' : '📐 Rules'}
                          </span>
                        </td>
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

// ─── AI Usage section ─────────────────────────────────────────────────────────

const USAGE_PERIODS = [
  { label: 'Today',  days: 1  },
  { label: '3 days', days: 3  },
  { label: '7 days', days: 7  },
  { label: '30 days',days: 30 },
  { label: '90 days',days: 90 },
]

function UsageSection({ usage: usageProp, onRefresh }) {
  const [selModel,    setSelModel]    = useState(null)   // null = "All"
  const [quota,       setQuota]       = useState(null)
  const [quotaErr,    setQuotaErr]    = useState(null)
  const [periodDays,  setPeriodDays]  = useState(30)
  const [localUsage,  setLocalUsage]  = useState(null)
  const [localLoading,setLocalLoading]= useState(false)

  // Fetch usage for the selected period whenever it changes.
  const fetchLocalUsage = (days) => {
    setLocalLoading(true)
    fetch(`${API}/usage?days=${days}`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setLocalUsage(d); setLocalLoading(false) })
      .catch(() => setLocalLoading(false))
  }
  useEffect(() => { fetchLocalUsage(periodDays) }, [periodDays])  // eslint-disable-line react-hooks/exhaustive-deps

  // The displayed data: local (period-specific) if loaded, otherwise the root prop.
  const usage = localUsage ?? usageProp

  // Auto-select the active provider+model when usage first loads.
  const activeKey = usage?.active_provider && usage?.active_model
    ? `${usage.active_provider}::${usage.active_model}`
    : null
  useEffect(() => {
    if (activeKey && selModel === null) setSelModel(activeKey)
  }, [activeKey])  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch quota once on mount so limits are visible without a button click.
  useEffect(() => {
    fetch(`${API}/provider/quota`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(setQuota)
      .catch(e => setQuotaErr(e.message))
  }, [])

  if (!usage) return (
    <p className="text-dim" style={{ fontSize: 13 }}>Loading usage data…</p>
  )

  const { period_days, by_provider = [], by_day = [], by_model_day = [], by_source = [] } = usage

  // Build the list of selectable model keys: "provider::model"
  const modelKeys = by_provider.map(p => `${p.provider}::${p.model}`)

  // Stats for the selected model (or overall totals)
  const selStats = selModel
    ? by_provider.find(p => `${p.provider}::${p.model}` === selModel) ?? {}
    : {
        total_tokens:      usage.total_tokens      ?? 0,
        prompt_tokens:     usage.total_prompt_tokens  ?? 0,
        completion_tokens: usage.total_completion_tokens ?? 0,
        rows:              usage.total_rows         ?? 0,
      }

  // Daily chart data — filter by selected model or use all-provider by_day.
  // Normalise to { date, prompt_tokens, completion_tokens, total_tokens } for the chart.
  const chartData = (() => {
    if (!selModel) return [...by_day].reverse()   // oldest → newest; already has `date` key
    const [sp, sm] = selModel.split('::')
    const filtered = by_model_day
      .filter(r => r.provider === sp && r.model === sm)
      .map(r => ({ ...r, date: r.day ?? r.date }))  // normalise day→date for XAxis
    return [...filtered].reverse()
  })()

  // Quota limits for the selected provider (or active provider)
  const selProvider  = selModel ? selModel.split('::')[0] : quota?.provider
  const selModelName = selModel ? selModel.split('::')[1] : null

  // Groq live rate-limit headers
  const groqLimits = quota?.rate_limits
  // Static free-tier limits (Gemini, Mistral)
  const freeLimits = quota?.free_tier_limits
  // Dashboard URL
  const dashUrl = quota?.dashboard_url

  // ── Per-provider cost tables (rough public pricing, USD per 1M tokens) ──────
  // Groq free tier = $0; paid tier shown as reference for estimation purposes.
  const COST_PER_1M = {
    groq:    { input: 0.05,  output: 0.08,  note: 'Groq paid (varies by model)' },
    gemini:  { input: 0.075, output: 0.30,  note: 'Gemini Flash free tier = $0; paid ~$0.075/$0.30' },
    mistral: { input: 0.10,  output: 0.30,  note: 'Mistral free tier; paid varies' },
    ollama:  { input: 0,     output: 0,     note: 'Local model — no cost' },
  }
  const costMeta   = COST_PER_1M[(selProvider ?? '').toLowerCase()] ?? null
  const estCostUSD = costMeta
    ? ((selStats.prompt_tokens ?? 0) * costMeta.input +
       (selStats.completion_tokens ?? 0) * costMeta.output) / 1_000_000
    : null

  // ── TPM utilisation (uses the active quota limits from /provider/quota) ──────
  // Best-available limit: live Groq header → free-tier table → null
  const activeLim = (() => {
    if (groqLimits?.tokens_limit) return { tpm: null, note: `${groqLimits.tokens_remaining} / ${groqLimits.tokens_limit} tokens remaining (period reset: ${groqLimits.tokens_reset ?? '?'})` }
    if (freeLimits) {
      // Prefer exact match; fall back to the most-restrictive entry so the gauge is safe.
      const exact = selModelName ? freeLimits[selModelName] : null
      const l = exact ?? Object.values(freeLimits).sort((a, b) => (a.tpm ?? 0) - (b.tpm ?? 0))[0]
      if (l) return { tpm: l.tpm, rpm: l.rpm, rpd: l.rpd }
    }
    return null
  })()
  // Average daily calls (from by_day rows count)
  const avgDailyCalls  = chartData.length
    ? chartData.reduce((s, d) => s + (d.rows ?? 0), 0) / chartData.length
    : 0
  const avgDailyTokens = chartData.length
    ? chartData.reduce((s, d) => s + (d.prompt_tokens ?? 0) + (d.completion_tokens ?? 0), 0) / chartData.length
    : 0

  return (
    <div>
      {/* ── Period selector ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="text-dim" style={{ fontSize: 12, marginRight: 4 }}>Period:</span>
        {USAGE_PERIODS.map(({ label, days }) => (
          <button
            key={days}
            className={`filter-btn${periodDays === days ? ' active' : ''}`}
            onClick={() => setPeriodDays(days)}
            style={{ fontSize: 12, padding: '3px 10px' }}
          >
            {label}
          </button>
        ))}
        {localLoading && <span className="text-dim" style={{ fontSize: 11, marginLeft: 4 }}>↻</span>}
      </div>

      {/* ── Model selector chips ──────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {/* "All" chip */}
        <button
          className={`live-chip live-chip-model ${!selModel ? 'active' : ''}`}
          style={{
            cursor: 'pointer', border: !selModel ? '1px solid var(--purple)' : undefined,
            opacity: 1, background: !selModel ? 'rgba(139,92,246,0.15)' : undefined,
          }}
          onClick={() => setSelModel(null)}
        >
          All models
        </button>
        {modelKeys.map(key => {
          const p = by_provider.find(p => `${p.provider}::${p.model}` === key)
          const active = selModel === key
          return (
            <button key={key}
              className="live-chip live-chip-model"
              style={{
                cursor: 'pointer',
                border: active ? '1px solid var(--purple)' : undefined,
                background: active ? 'rgba(139,92,246,0.15)' : undefined,
                opacity: 1,
              }}
              onClick={() => setSelModel(active ? null : key)}
            >
              {key.replace('::', ' · ')}
              <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--dim)' }}>
                {fmtTokens(p?.total_tokens ?? 0)}
              </span>
            </button>
          )
        })}
        <button className="btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
          onClick={() => { onRefresh(); fetchLocalUsage(periodDays) }}>
          ↺ Refresh
        </button>
      </div>

      {/* ── Summary stat cards ────────────────────────────────────────── */}
      <div className="usage-summary-row" style={{ marginBottom: 16 }}>
        <div className="usage-stat-card">
          <span className="usage-stat-label">Total tokens</span>
          <span className="usage-stat-value">{fmtTokens(selStats.total_tokens ?? 0)}</span>
          <span className="usage-stat-sub">last {period_days}d</span>
        </div>
        <div className="usage-stat-card">
          <span className="usage-stat-label">Prompt</span>
          <span className="usage-stat-value">{fmtTokens(selStats.prompt_tokens ?? 0)}</span>
          <span className="usage-stat-sub">input</span>
        </div>
        <div className="usage-stat-card">
          <span className="usage-stat-label">Completion</span>
          <span className="usage-stat-value">{fmtTokens(selStats.completion_tokens ?? 0)}</span>
          <span className="usage-stat-sub">output</span>
        </div>
        <div className="usage-stat-card">
          <span className="usage-stat-label">LLM calls</span>
          <span className="usage-stat-value">{(selStats.rows ?? 0).toLocaleString()}</span>
          <span className="usage-stat-sub">last {period_days}d · ~{Math.round(avgDailyCalls)}/day</span>
        </div>
        {estCostUSD !== null && (
          <div className="usage-stat-card" style={{ borderColor: 'rgba(251,191,36,0.3)' }}>
            <span className="usage-stat-label">Est. cost</span>
            <span className="usage-stat-value" style={{ color: estCostUSD < 0.001 ? 'var(--green)' : 'var(--yellow)' }}>
              {estCostUSD < 0.001 ? '$0' : `$${estCostUSD.toFixed(4)}`}
            </span>
            <span className="usage-stat-sub">{costMeta.note}</span>
          </div>
        )}
      </div>

      {/* ── By-source breakdown ──────────────────────────────────────── */}
      {/* "Signals / Explorer" = AI analysis runs from Dashboard/Explorer scans */}
      {/* "Backtesting" = LLM-mode backtest runs */}
      {by_source.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          {by_source.map(s => (
            <div key={s.source} className="usage-stat-card" style={{ flex: '1 1 140px' }}>
              <span className="usage-stat-label">{s.label}</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>
                {fmtTokens(s.total_tokens)}
              </span>
              <span className="usage-stat-sub">
                {s.rows} call{s.rows !== 1 ? 's' : ''} · {fmtTokens(s.prompt_tokens)} in / {fmtTokens(s.completion_tokens)} out
              </span>
            </div>
          ))}
          {!by_source.find(s => s.source === 'signal') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">Signals / Explorer</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no AI scans yet this period</span>
            </div>
          )}
          {!by_source.find(s => s.source === 'backtest_review') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">AI Review</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no reviews yet this period</span>
            </div>
          )}
          {!by_source.find(s => s.source === 'backtest_experiment_advisor') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">Experiment Advisor</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no suggestions yet this period</span>
            </div>
          )}
          {!by_source.find(s => s.source === 'backtest_compare') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">Run Compare</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no comparisons yet this period</span>
            </div>
          )}
        </div>
      )}

      {/* ── Daily usage chart ─────────────────────────────────────────── */}
      {chartData.length > 0 ? (
        <div style={{ marginBottom: 20 }}>
          <div className="settings-label" style={{ marginBottom: 8 }}>
            Daily token usage{selModel ? ` — ${selModel.replace('::', ' · ')}` : ' — all models'}
          </div>
          <ResponsiveContainer width="100%" height={160}>
            {chartData.length < 3 ? (
              /* BarChart for sparse data (1–2 days) — AreaChart needs ≥3 points to draw a line */
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={v => v?.slice(5)} />
                <YAxis tick={AXIS_TICK} tickFormatter={v => fmtTokens(v)} width={52} />
                <Tooltip
                  {...CHART_TOOLTIP_STYLE}
                  formatter={(v, name) => [v.toLocaleString(), name === 'prompt_tokens' ? 'Prompt' : 'Completion']}
                  labelFormatter={l => `Date: ${l}`}
                />
                <Bar dataKey="prompt_tokens"     fill="#a855f7" name="prompt_tokens"     stackId="a" />
                <Bar dataKey="completion_tokens" fill="#818cf8" name="completion_tokens" stackId="a" radius={[3,3,0,0]} />
              </BarChart>
            ) : (
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="usageGradPrompt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#a855f7" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="usageGradCompl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#818cf8" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#818cf8" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={v => v?.slice(5)} />
                <YAxis tick={AXIS_TICK} tickFormatter={v => fmtTokens(v)} width={52} />
                <Tooltip
                  {...CHART_TOOLTIP_STYLE}
                  formatter={(v, name) => [v.toLocaleString(), name === 'prompt_tokens' ? 'Prompt' : name === 'completion_tokens' ? 'Completion' : 'Total']}
                  labelFormatter={l => `Date: ${l}`}
                />
                <Area type="monotone" dataKey="prompt_tokens"
                      stroke="#a855f7" strokeWidth={2} fill="url(#usageGradPrompt)"
                      dot={{ r: 3, fill: '#a855f7' }} name="prompt_tokens" />
                <Area type="monotone" dataKey="completion_tokens"
                      stroke="#818cf8" strokeWidth={1.5} fill="url(#usageGradCompl)"
                      dot={{ r: 2, fill: '#818cf8' }} name="completion_tokens" />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-dim" style={{ fontSize: 12, marginBottom: 16 }}>
          No usage data for this period.{' '}
          {selModel && <span>Try selecting <strong>All models</strong>.</span>}
        </p>
      )}

      {/* ── Daily LLM calls chart ─────────────────────────────────────── */}
      {chartData.length > 0 && chartData.some(d => (d.rows ?? 0) > 0) && (
        <div style={{ marginBottom: 20 }}>
          <div className="settings-label" style={{ marginBottom: 8 }}>
            LLM calls per day{selModel ? ` — ${selModel.replace('::', ' · ')}` : ' — all models'}
          </div>
          <ResponsiveContainer width="100%" height={110}>
            <BarChart data={[...chartData]} margin={{ top: 2, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={v => v?.slice(5)} />
              <YAxis tick={AXIS_TICK} allowDecimals={false} width={32} />
              <Tooltip
                {...CHART_TOOLTIP_STYLE}
                formatter={(v) => [v, 'Calls']}
                labelFormatter={l => `Date: ${l}`}
              />
              <Bar dataKey="rows" fill="#34d399" radius={[3, 3, 0, 0]} name="Calls" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── TPM / quota utilisation bar ───────────────────────────────── */}
      {activeLim?.tpm && avgDailyTokens > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="settings-label" style={{ marginBottom: 6 }}>TPM headroom</div>
          {(() => {
            // Rough: avg daily tokens ÷ active trading hours (7h) ÷ 60min
            const estTpm = Math.round(avgDailyTokens / (7 * 60))
            const pct    = Math.min(100, Math.round(estTpm / activeLim.tpm * 100))
            const color  = pct >= 80 ? '#f87171' : pct >= 50 ? '#fbbf24' : '#34d399'
            return (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginBottom: 4 }}>
                  <span>~{estTpm.toLocaleString()} TPM avg (7h trading day)</span>
                  <span>limit {activeLim.tpm.toLocaleString()} TPM · <strong style={{ color }}>{pct}% used</strong></span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .4s' }} />
                </div>
                {activeLim.rpm && (
                  <p className="text-dim" style={{ fontSize: 11, marginTop: 4 }}>
                    RPM limit: {activeLim.rpm} · RPD limit: {activeLim.rpd?.toLocaleString() ?? '—'}
                  </p>
                )}
              </div>
            )
          })()}
        </div>
      )}
      {activeLim?.note && (
        <div style={{ marginBottom: 16, padding: '8px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, fontSize: 11, color: 'var(--dim)' }}>
          📊 {activeLim.note}
        </div>
      )}

      {/* ── Quota / limits panel ──────────────────────────────────────── */}
      {quota && (() => {
        // Use selProvider (chip selection) so note/URL update when the user switches models;
        // fall back to quota.provider (active backend provider) if nothing is selected.
        const prov = (selProvider ?? quota.provider ?? '').toLowerCase()
        // Per-provider console URLs and documented free-tier limits
        const PROVIDER_META = {
          groq:    { url: 'https://console.groq.com/settings/limits',      label: 'Groq console',
                     note: 'Free tier: 30 RPM / 6,000 TPM / 14,400 RPD (model-dependent). Probe may return null headers on free plan.',
                     docLimits: [{ model: 'any', rpm: 30, tpm: 6000, rpd: 14400 }] },
          gemini:  { url: 'https://aistudio.google.com/app/apikey',        label: 'Google AI Studio',
                     note: 'Free tier: 15 RPM / 1M TPM / 1,500 RPD for gemini-3.5-flash family (see table for all models). Google AI Studio does not expose a programmatic quota API — check live usage at the link above.' },
          mistral: { url: 'https://console.mistral.ai/usage/',             label: 'Mistral console',
                     note: 'Free-tier (La Plateforme trial): 30 RPM / 100k TPM / 500 RPD per model. Mistral does not expose a usage API — monitor consumption at the console link above.' },
          ollama:  { url: null, label: null, note: 'Local model — no rate limits apply.' },
        }
        const meta = PROVIDER_META[prov] ?? { url: null, label: 'Provider dashboard', note: null }

        // Live rate-limit headers (Groq)
        const liveRows = groqLimits
          ? [
              ['Tokens limit',       groqLimits.tokens_limit],
              ['Tokens remaining',   groqLimits.tokens_remaining],
              ['Tokens reset',       groqLimits.tokens_reset],
              ['Requests limit',     groqLimits.requests_limit],
              ['Requests remaining', groqLimits.requests_remaining],
              ['Requests reset',     groqLimits.requests_reset],
            ].filter(([, v]) => v != null)
          : []

        // Free-tier model limits (Gemini, Mistral).
        // Show ALL entries regardless of chip selection so the table is always visible;
        // the row matching the selected model is highlighted.
        const freeLimitEntries = freeLimits ? Object.entries(freeLimits) : []

        return (
          <div className="usage-quota-box">
            {/* Header row: provider chip + note + dashboard link */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <span className="live-chip live-chip-model">{selProvider ?? quota.provider}</span>
              {meta.url && (
                <a href={meta.url} target="_blank" rel="noreferrer"
                   className="text-blue-link" style={{ fontSize: 12, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {meta.label} ↗
                </a>
              )}
              {/* Show our friendly meta note first; demote the raw probe note to footnote */}
              {meta.note && (
                <p className="text-dim" style={{ fontSize: 11, width: '100%', margin: '4px 0 0 0', lineHeight: 1.5 }}>
                  {meta.note}
                </p>
              )}
              {/* Only show the raw backend note when the chip matches the active backend provider,
                  so switching to a different chip doesn't bleed in stale provider messages. */}
              {quota.note && quota.note !== meta.note
               && (!selProvider || selProvider.toLowerCase() === (quota.provider ?? '').toLowerCase())
               && (
                <p className="text-dim" style={{ fontSize: 10, width: '100%', margin: '2px 0 0 0', opacity: 0.6 }}>
                  ℹ︎ {quota.note}
                </p>
              )}
            </div>

            {/* Live rate-limit headers (Groq — when available) */}
            {liveRows.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>Live metric</th><th style={{ textAlign: 'right' }}>Value</th></tr></thead>
                  <tbody>
                    {liveRows.map(([label, val], i) => (
                      <tr key={i}>
                        <td className="text-dim" style={{ fontSize: 12 }}>{label}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{val}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Free-tier documented limits (Gemini, Mistral) */}
            {freeLimitEntries.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th style={{ textAlign: 'right' }}>RPM</th>
                      <th style={{ textAlign: 'right' }}>TPM</th>
                      <th style={{ textAlign: 'right' }}>RPD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {freeLimitEntries.map(([model, lim], i) => (
                      <tr key={i} style={{ background: model === selModelName ? 'rgba(168,85,247,0.08)' : undefined }}>
                        <td className="text-dim" style={{ fontSize: 12 }}>{model}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.tpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpd?.toLocaleString() ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Groq: no live data — show documented fallback */}
            {groqLimits && liveRows.length === 0 && meta.docLimits && (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Documented free-tier limit</th>
                      <th style={{ textAlign: 'right' }}>RPM</th>
                      <th style={{ textAlign: 'right' }}>TPM</th>
                      <th style={{ textAlign: 'right' }}>RPD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.docLimits.map((lim, i) => (
                      <tr key={i}>
                        <td className="text-dim" style={{ fontSize: 12 }}>{selModelName ?? lim.model}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.tpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpd?.toLocaleString() ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* quota field (Ollama / custom) */}
            {!groqLimits && !freeLimits && quota.quota && quota.quota !== 'n/a' && (
              <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>
                Quota: <strong style={{ color: '#f8fafc' }}>{quota.quota}</strong>
              </p>
            )}
          </div>
        )
      })()}
      {quotaErr && <p className="settings-err" style={{ marginTop: 8 }}>✗ Quota: {quotaErr}</p>}
    </div>
  )
}

// ─── Settings page ────────────────────────────────────────────────────────────

const SETTINGS_SECTIONS = [
  { id: 'settings-signal',       icon: '📡', label: 'Signal Config' },
  { id: 'settings-paper',        icon: '📈', label: 'Paper Trading' },
  { id: 'settings-ai-provider', icon: '🧠', label: 'AI Provider' },
  { id: 'settings-usage',       icon: '⚡', label: 'AI Usage' },
  { id: 'settings-perf',        icon: '🚀', label: 'Performance' },
  { id: 'settings-cache',       icon: '💾', label: 'Data Cache' },
  { id: 'settings-data',        icon: '🗑️', label: 'Data' },
]

function SettingSection({ id, title, icon, children }) {
  return (
    <div id={id} className="settings-section">
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

function SettingsPage({ usage, onUsageRefresh, onHealthRefresh }) {
  // ── LLM Provider ────────────────────────────────────────────────────────────
  const [llmProvider,  setLlmProvider]  = useState('ollama')
  const [llmApiKey,    setLlmApiKey]    = useState('')
  const [llmModel,     setLlmModel]     = useState('')
  const [llmBaseUrl,   setLlmBaseUrl]   = useState('')
  const [llmApiKeySet, setLlmApiKeySet] = useState(false)
  const [showLlmApiKey, setShowLlmApiKey] = useState(false)
  const [llmStatus,    setLlmStatus]    = useState(null)
  const [llmErr,       setLlmErr]       = useState('')
  const [useEnvDefaults, setUseEnvDefaults] = useState(false)
  const [llmModelEnvDefault,   setLlmModelEnvDefault]   = useState('')
  const [llmBaseUrlEnvDefault, setLlmBaseUrlEnvDefault] = useState('')
  const [llmApiKeyEnvSet,      setLlmApiKeyEnvSet]      = useState(false)
  const [llmReasoningEffort,   setLlmReasoningEffort]   = useState('none')
  const [providerModels,       setProviderModels]       = useState([])
  const [modelChoice,          setModelChoice]          = useState('')
  const [llmFallbackProvider,  setLlmFallbackProvider]  = useState('')
  const [llmFallbackModel,     setLlmFallbackModel]     = useState('')

  // ── Signal-scan LLM switch ──────────────────────────────────────────────────
  const [signalLlmEnabled,     setSignalLlmEnabled]     = useState(true)
  const [signalLlmSaveStatus,  setSignalLlmSaveStatus]  = useState(null)   // null|'saving'|'ok'|'error'

  const saveSignalLlmEnabled = async (enabled) => {
    setSignalLlmSaveStatus('saving')
    try {
      const r = await fetch(`${API}/settings/signal-scan-llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ enabled }),
      })
      if (!r.ok) throw new Error(await r.text())
      setSignalLlmEnabled(enabled)
      setSignalLlmSaveStatus('ok')
      setTimeout(() => setSignalLlmSaveStatus(null), 3000)
    } catch (e) {
      setSignalLlmSaveStatus('error')
      setTimeout(() => setSignalLlmSaveStatus(null), 4000)
    }
  }

  const cloudModelSuggestions = {
    groq: ['qwen/qwen3.6-27b'],
    gemini: ['gemini-3.5-flash-lite', 'gemini-3.5-flash'],
    mistral: ['mistral-small-latest', 'mistral-large-latest'],
  }
  const REASONING_OPTIONS = ['none', 'low', 'medium', 'high']
  const supportsReasoning = ['groq', 'gemini', 'mistral'].includes(llmProvider)
  const ollamaModelSuggestions = ['qwen2.5:3b', 'qwen2.5:7b', 'qwen2.5:14b']
  const envDefaultsActive = useEnvDefaults && llmProvider !== 'custom'

  // ── Ollama model + timeout ──────────────────────────────────────────────────
  const [models,  setModels]  = useState([])
  const [model,   setModel]   = useState('')
  const [timeout, setTimeout_] = useState('')
  const [ollamaStatus, setOllamaStatus] = useState(null)
  const [ollamaErr,    setOllamaErr]    = useState('')
  const modelValue = envDefaultsActive ? llmModelEnvDefault : (llmProvider === 'ollama' ? model : llmModel)
  const modelOptions = [...new Set(
    llmProvider === 'ollama'
      ? [...ollamaModelSuggestions, ...models]
      : [...(providerModels.length ? providerModels : (cloudModelSuggestions[llmProvider] ?? []))]
  )]
  const modelSelectValue = modelChoice || (modelOptions.includes(modelValue) ? modelValue : '__custom__')
  const customModelEntry = llmProvider === 'custom' || modelSelectValue === '__custom__'
  // Show dots whenever a key is known — either saved in DB or present in .env,
  // regardless of whether the "Use .env defaults" checkbox is ticked.
  const savedApiKeyMask = (llmApiKeySet || llmApiKeyEnvSet) ? '••••••••••••' : ''

  // ── Paper trading settings ──────────────────────────────────────────────────
  const [paperEnabled,        setPaperEnabled]        = useState(false)
  const [alpacaUrl,           setAlpacaUrl]           = useState('https://paper-api.alpaca.markets')
  const [alpacaKeyId,         setAlpacaKeyId]         = useState('')
  const [alpacaKeyIdSet,      setAlpacaKeyIdSet]      = useState(false)
  const [showAlpacaKeyId,     setShowAlpacaKeyId]     = useState(false)
  const [alpacaSecret,        setAlpacaSecret]        = useState('')
  const [alpacaSecretSet,     setAlpacaSecretSet]     = useState(false)
  const [showAlpacaSecret,    setShowAlpacaSecret]    = useState(false)
  const [paperPositionSize,   setPaperPositionSize]   = useState(500)
  const [paperMinConf,        setPaperMinConf]        = useState(75)
  const [paperSaveStatus,     setPaperSaveStatus]     = useState(null)
  const [alpacaTestResult,    setAlpacaTestResult]    = useState(null)  // null | {equity,buying_power} | 'error'
  const [alpacaTestLoading,   setAlpacaTestLoading]   = useState(false)
  const [useAlpacaEnvDefaults,setUseAlpacaEnvDefaults]= useState(false)
  const [alpacaKeyIdEnvSet,   setAlpacaKeyIdEnvSet]   = useState(false)
  const [alpacaSecretEnvSet,  setAlpacaSecretEnvSet]  = useState(false)

  const savePaperSettings = async () => {
    setPaperSaveStatus('saving')
    try {
      const body = {
        enabled: paperEnabled,
        paper_url: alpacaUrl,
        position_size: parseFloat(paperPositionSize) || 500,
        min_confidence: parseFloat(paperMinConf) || 75,
      }
      if (useAlpacaEnvDefaults) {
        // Signal the backend to clear DB credentials and fall back to .env vars.
        body.use_env = true
        body.key_id = ''
        body.secret_key = ''
      } else {
        if (alpacaKeyId)  body.key_id    = alpacaKeyId
        if (alpacaSecret) body.secret_key = alpacaSecret
      }
      const r = await fetch(`${API}/settings/alpaca`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      if (!useAlpacaEnvDefaults) {
        if (alpacaKeyId)  setAlpacaKeyIdSet(true)
        if (alpacaSecret) setAlpacaSecretSet(true)
      }
      // Keep Key ID visible after save (it's not secret); clear secret
      setAlpacaSecret('')
      setShowAlpacaSecret(false)
      setPaperSaveStatus('ok')
      setTimeout(() => setPaperSaveStatus(null), 3000)
    } catch (e) {
      setPaperSaveStatus('error')
      setTimeout(() => setPaperSaveStatus(null), 4000)
    }
  }

  const testAlpacaConnection = async () => {
    setAlpacaTestLoading(true)
    setAlpacaTestResult(null)
    try {
      // POST currently-typed credentials so the test works before saving.
      // Empty strings are omitted — backend falls back to DB / env values.
      const body = {}
      if (alpacaUrl)   body.paper_url   = alpacaUrl
      if (alpacaKeyId) body.key_id      = alpacaKeyId
      if (alpacaSecret) body.secret_key = alpacaSecret
      const r = await fetch(`${API}/settings/alpaca/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setAlpacaTestResult(d.account ?? 'error')
    } catch (e) {
      setAlpacaTestResult('error')
    } finally {
      setAlpacaTestLoading(false)
    }
  }

  const revealAlpacaSecret = () => {
    // Key reveal removed for security — keys are write-only from the browser.
    // To verify the current secret, use `fly secrets list` in your terminal.
    setShowAlpacaSecret(v => !v)
  }

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

  // ── Performance / parallelism ────────────────────────────────────────────────
  const [perfSettings,     setPerfSettings]     = useState(null)
  const [perfRateLimits,   setPerfRateLimits]   = useState(null)
  const [concTickers,      setConcTickers]      = useState(4)
  const [concLlm,          setConcLlm]          = useState(2)
  const [perfSaveStatus,   setPerfSaveStatus]   = useState(null)

  const loadPerfSettings = async () => {
    try {
      const r = await fetch(`${API}/settings/performance`, { headers: getAuthHeaders() })
      if (!r.ok) return
      const d = await r.json()
      setPerfSettings(d)
      setPerfRateLimits(d.rate_limits)
      setConcTickers(d.concurrent_tickers ?? 4)
      setConcLlm(d.concurrent_llm ?? 2)
    } catch (e) { /* best-effort */ }
  }

  const savePerfSettings = async () => {
    setPerfSaveStatus('saving')
    try {
      const r = await fetch(
        `${API}/settings/performance?concurrent_tickers=${concTickers}&concurrent_llm=${concLlm}`,
        { method: 'POST' }
      )
      if (!r.ok) throw new Error(await r.text())
      setPerfSaveStatus('ok')
      setTimeout(() => setPerfSaveStatus(null), 3000)
    } catch (e) { setPerfSaveStatus('error') }
  }

  // ── Data cache ──────────────────────────────────────────────────────────────
  const [cacheStats,       setCacheStats]       = useState(null)
  const [cacheStatsErr,    setCacheStatsErr]    = useState(null)
  const [cacheEvictStatus, setCacheEvictStatus] = useState(null)

  const loadCacheStats = async () => {
    setCacheStatsErr(null)
    try {
      const r = await fetch(`${API}/data/cache/stats`, { headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      setCacheStats(await r.json())
    } catch (e) { setCacheStatsErr(String(e)) }
  }

  const evictCache = async (hours) => {
    setCacheEvictStatus('clearing')
    try {
      const r = await fetch(`${API}/data/cache?older_than_hours=${hours}`, { method: 'DELETE', headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setCacheEvictStatus(`ok:${d.deleted}`)
      loadCacheStats()
      setTimeout(() => setCacheEvictStatus(null), 4000)
    } catch (e) { setCacheEvictStatus('error') }
  }

  // Load on mount
  useEffect(() => {
    Promise.all([
      fetch(`${API}/settings`, { headers: getAuthHeaders() }).then(r => r.json()),
      fetch(`${API}/settings/models`, { headers: getAuthHeaders() }).then(r => r.json()),
    ]).then(([cfg, m]) => {
      // LLM provider
      setLlmProvider(cfg.llm_provider ?? 'ollama')
      setLlmApiKeySet(cfg.llm_api_key_set ?? false)
      setLlmModel(cfg.llm_model ?? '')
      setLlmBaseUrl(cfg.llm_base_url ?? '')
      setLlmModelEnvDefault(cfg.llm_model_env_default ?? '')
      setLlmBaseUrlEnvDefault(cfg.llm_base_url_env_default ?? '')
      setLlmApiKeyEnvSet(cfg.llm_api_key_env_set ?? false)
      setLlmReasoningEffort(cfg.llm_reasoning_effort ?? 'none')
      // Ollama
      setModel(cfg.ollama_model ?? '')
      setTimeout_(String(cfg.ollama_timeout ?? 120))
      setModels(m.provider === 'ollama' ? (m.models ?? []) : [])
      setProviderModels(m.provider === 'ollama' ? [] : (m.models ?? []))
      // Other
      setScanInterval(String(cfg.scan_interval_minutes ?? 15))
      setSchedulerRunning(cfg.scheduler_running ?? true)
      setAlertsOn(cfg.alerts_enabled ?? true)
      setSignalLlmEnabled(cfg.signal_scan_llm_enabled ?? true)
      // Paper trading
      setPaperEnabled(cfg.paper_trading_enabled ?? false)
      setAlpacaUrl(cfg.alpaca_paper_url ?? 'https://paper-api.alpaca.markets')
      setAlpacaKeyId(cfg.alpaca_key_id ?? '')          // pre-fill; Key ID is not secret
      setAlpacaKeyIdSet(cfg.alpaca_key_id_set ?? false)
      setAlpacaSecretSet(cfg.alpaca_secret_set ?? false)
      setAlpacaKeyIdEnvSet(cfg.alpaca_key_id_env_set ?? false)
      setAlpacaSecretEnvSet(cfg.alpaca_secret_env_set ?? false)
      setPaperPositionSize(cfg.paper_trade_position_size ?? 500)
      if (cfg.paper_trade_min_confidence != null) setPaperMinConf(cfg.paper_trade_min_confidence)
    }).catch(() => {})
    loadCacheStats()
    loadPerfSettings()
  }, [])

  const loadProviderSettings = async (provider) => {
    const query = `?provider=${encodeURIComponent(provider)}`
    const [cfg, modelData] = await Promise.all([
      fetch(`${API}/settings${query}`, { headers: getAuthHeaders() }).then(r => r.json()),
      fetch(`${API}/settings/models${query}`, { headers: getAuthHeaders() }).then(r => r.json()),
    ])
    setLlmApiKeySet(cfg.llm_api_key_set ?? false)
    setLlmModel(cfg.llm_model ?? '')
    setLlmBaseUrl(cfg.llm_base_url ?? '')
    setLlmModelEnvDefault(cfg.llm_model_env_default ?? '')
    setLlmBaseUrlEnvDefault(cfg.llm_base_url_env_default ?? '')
    setLlmApiKeyEnvSet(cfg.llm_api_key_env_set ?? false)
    setLlmReasoningEffort(cfg.llm_reasoning_effort ?? 'none')
    setLlmFallbackProvider(cfg.llm_fallback_provider ?? '')
    setLlmFallbackModel(cfg.llm_fallback_model ?? '')
    if (provider === 'ollama') setModels(modelData.models ?? [])
    else setProviderModels(modelData.models ?? [])
  }

  const saveLlm = async () => {
    setLlmStatus('saving'); setLlmErr('')
    try {
      const body = { provider: llmProvider }
      if (envDefaultsActive) {
        body.api_key = ''
        body.model = ''
        body.base_url = ''
      } else {
        if (llmApiKey)  body.api_key  = llmApiKey
        if (llmModel)   body.model    = llmModel
        if (llmBaseUrl) body.base_url = llmBaseUrl
      }
      if (supportsReasoning) body.reasoning_effort = llmReasoningEffort
      body.fallback_provider = llmFallbackProvider
      body.fallback_model    = llmFallbackModel
      const r = await fetch(`${API}/settings/llm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      if (llmApiKey) { setLlmApiKey(''); setLlmApiKeySet(true) }
      if (envDefaultsActive) { setLlmApiKeySet(false); setLlmModel(''); setLlmBaseUrl('') }
      setLlmStatus('ok')
      onHealthRefresh?.()   // refresh header chip immediately — no page reload needed
      setTimeout(() => setLlmStatus(null), 3000)
    } catch (e) { setLlmStatus('error'); setLlmErr(e.message) }
  }

  const saveOllama = async () => {
    setOllamaStatus('saving'); setOllamaErr('')
    try {
      const body = {}
      body.model = useEnvDefaults ? '' : model
      if (timeout) body.timeout = parseInt(timeout, 10)
      const r = await fetch(`${API}/settings/ollama`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      setOllamaStatus('ok')
      onHealthRefresh?.()   // refresh header chip immediately — no page reload needed
      setTimeout(() => setOllamaStatus(null), 3000)
    } catch (e) { setOllamaStatus('error'); setOllamaErr(e.message) }
  }

  const saveScheduler = async () => {
    setSchedStatus('saving'); setSchedErr('')
    try {
      await fetch(`${API}/settings/scan-interval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
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
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
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
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
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
      const r = await fetch(`${API}/data/reset`, { method: 'POST', headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      setResetStatus('ok')
      setTimeout(() => setResetStatus(null), 4000)
    } catch (e) { setResetStatus('error') }
  }

  return (
    <div className="settings-layout">
      {/* ── Sticky TOC sidebar ─────────────────────────────────────────────── */}
      <nav className="settings-toc">
        <div className="settings-toc-title">Settings</div>
        {SETTINGS_SECTIONS.map(s => (
          <button
            key={s.id}
            className="settings-toc-link"
            onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {s.icon} {s.label}
          </button>
        ))}
      </nav>

      <div className="settings-page">

      {/* ── Signal Configuration ──────────────────────────────────────────── */}
      <SettingSection id="settings-signal" title="Signal Configuration" icon="📡">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 18 }}>
          Control how the system scans for signals: when it runs, who gets notified,
          and whether AI analysis is applied.
        </p>

        {/* ─ Scheduler ─ */}
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 10 }}>⏰ Scheduler</div>

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

        <div style={{ borderTop: '1px solid var(--border)', margin: '18px 0', opacity: 0.4 }} />

        {/* ─ Alerts ─ */}
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 10 }}>🔔 Alerts</div>

        <div className="settings-row">
          <div className="settings-row-label">
            <span>Alert dispatch</span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {alertsOn ? 'Enabled — alerts sent on actionable signals (email / Slack / Telegram)' : 'Suppressed — all alert channels silenced'}
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

        <div style={{ borderTop: '1px solid var(--border)', margin: '18px 0', opacity: 0.4 }} />

        {/* ─ AI Analysis ─ */}
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 10 }}>🤖 AI Analysis</div>

        <div className="settings-row">
          <div className="settings-row-label">
            <span style={{ color: signalLlmEnabled ? undefined : 'var(--dim)' }}>
              {signalLlmEnabled ? 'LLM enabled' : 'Rules-only (LLM disabled)'}
            </span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {signalLlmEnabled
                ? 'AI analysis runs on every scan and on-demand call — consumes provider quota'
                : 'LLM skill skipped globally — no API quota used during signal scanning'}
            </span>
          </div>
          <button
            className={`settings-toggle ${signalLlmEnabled ? 'on' : 'off'}`}
            onClick={() => saveSignalLlmEnabled(!signalLlmEnabled)}
            disabled={signalLlmSaveStatus === 'saving'}
            title={signalLlmEnabled ? 'Click to disable LLM for signal scanning' : 'Click to enable LLM for signal scanning'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {signalLlmSaveStatus === 'saving' && <span style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8, display: 'block' }}>Saving…</span>}
        {signalLlmSaveStatus === 'ok'     && <span className="settings-ok" style={{ marginTop: 8, display: 'block' }}>✓ Saved</span>}
        {signalLlmSaveStatus === 'error'  && <span className="settings-err" style={{ marginTop: 8, display: 'block' }}>✗ Failed</span>}
      </SettingSection>

      {/* ── Paper Trading ─────────────────────────────────────────────────── */}
      <SettingSection id="settings-paper" title="Paper Trading" icon="📈">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 16 }}>
          Automatically place bracket orders on your <strong>Alpaca paper account</strong> whenever
          an actionable signal fires. No real money is involved — paper trading is a free simulation.
          Get API keys at <a href="https://app.alpaca.markets/paper-trading" target="_blank" rel="noreferrer"
            style={{ color: 'var(--accent)' }}>app.alpaca.markets</a>.
        </p>

        {/* Enable toggle */}
        <div className="settings-row" style={{ marginBottom: 18 }}>
          <div className="settings-row-label">
            <span style={{ fontWeight: 600 }}>
              {paperEnabled ? '📈 Paper trading active' : 'Paper trading disabled'}
            </span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {paperEnabled
                ? 'Bracket orders placed automatically on each actionable signal'
                : 'Toggle on to start placing paper orders automatically'}
            </span>
          </div>
          <button className={`settings-toggle ${paperEnabled ? 'on' : 'off'}`}
                  onClick={() => setPaperEnabled(v => !v)}>
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 12 }}>🔑 Alpaca Connection</div>

        <button
          type="button"
          className={`settings-env-btn${useAlpacaEnvDefaults ? ' active' : ''}`}
          onClick={() => {
            setUseAlpacaEnvDefaults(v => !v)
            setAlpacaKeyId('')
            setAlpacaSecret('')
            setShowAlpacaSecret(false)
          }}
        >
          {useAlpacaEnvDefaults ? '✓ Using environment defaults' : '↩ Load Environment Default Values'}
          <span className="settings-env-btn-sub">
            {useAlpacaEnvDefaults
              ? '(click to clear and enter values manually)'
              : '(if set in .env — ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY)'}
          </span>
        </button>

        <div className="settings-field" style={{ marginBottom: 12, marginTop: 12 }}>
          <label className="settings-label">Paper API URL</label>
          <input type="text" value={alpacaUrl} onChange={e => setAlpacaUrl(e.target.value)}
                 className="settings-select" placeholder="https://paper-api.alpaca.markets"
                 style={{ marginTop: 4 }} />
        </div>

        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label className="settings-label">API Key ID</label>
          <div className="settings-secret-field" style={{ marginTop: 4 }}>
            <input
              type={showAlpacaKeyId ? 'text' : 'password'}
              value={useAlpacaEnvDefaults ? '' : (alpacaKeyId || (alpacaKeyIdSet && !showAlpacaKeyId ? '••••••••••••' : ''))}
              onFocus={() => { if (!alpacaKeyId && alpacaKeyIdSet) setAlpacaKeyId('') }}
              onChange={e => setAlpacaKeyId(e.target.value)}
              disabled={useAlpacaEnvDefaults}
              className="settings-select"
              autoComplete="new-password"
              placeholder={
                useAlpacaEnvDefaults
                  ? (alpacaKeyIdEnvSet ? 'Using Key ID from .env' : 'No Key ID set in .env')
                  : (alpacaKeyIdSet ? 'Key saved — focus to replace' : 'PKxxxxxxxxxxxxxxxxxxxxxx')
              }
            />
            <button type="button" className="settings-secret-toggle"
                    disabled={useAlpacaEnvDefaults}
                    onClick={() => setShowAlpacaKeyId(v => !v)}>
              {showAlpacaKeyId ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <div className="settings-field" style={{ marginBottom: 16 }}>
          <label className="settings-label">API Secret Key</label>
          <div className="settings-secret-field" style={{ marginTop: 4 }}>
            <input type={showAlpacaSecret ? 'text' : 'password'}
                   value={useAlpacaEnvDefaults ? '' : (alpacaSecret || (alpacaSecretSet && !showAlpacaSecret ? '••••••••••••' : ''))}
                   onFocus={() => { if (!alpacaSecret && alpacaSecretSet) setAlpacaSecret('') }}
                   onChange={e => setAlpacaSecret(e.target.value)}
                   disabled={useAlpacaEnvDefaults}
                   className="settings-select"
                   placeholder={
                     useAlpacaEnvDefaults
                       ? (alpacaSecretEnvSet ? 'Using Secret from .env' : 'No Secret set in .env')
                       : (alpacaSecretSet ? 'Secret saved — focus to replace' : 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
                   } />
            <button type="button" className="settings-secret-toggle"
                    disabled={useAlpacaEnvDefaults}
                    onClick={() => {
                      if (showAlpacaSecret) { setAlpacaSecret(''); setShowAlpacaSecret(false) }
                      else { revealAlpacaSecret() }
                    }}>
              {showAlpacaSecret ? 'Hide' : 'Show'}
            </button>
          </div>
          {!useAlpacaEnvDefaults && alpacaSecretSet && !alpacaSecret && (
            <span className="text-dim" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
              ✓ Secret is set — to verify the value, use <code className="inline-code">fly secrets list</code>
            </span>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0 16px', opacity: 0.4 }} />
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 12 }}>💵 Trade Sizing</div>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
          <div className="settings-field">
            <label className="settings-label" title="Fixed dollar amount invested per signal">
              Position size per trade
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span style={{ color: 'var(--dim)', fontSize: 13 }}>$</span>
              <input type="number" min={1} step={50} value={paperPositionSize}
                     onChange={e => setPaperPositionSize(e.target.value)}
                     className="settings-num-input" style={{ width: 100 }} />
            </div>
          </div>
          <div className="settings-field" style={{ minWidth: 200 }}>
            <label className="settings-label"
                   title="Minimum signal confidence to place an order (can be set higher than the alert floor)">
              Min confidence to trade: <strong>{paperMinConf}%</strong>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <input type="range" min={0} max={100} step={5} value={paperMinConf}
                     onChange={e => setPaperMinConf(Number(e.target.value))}
                     className="filter-range" style={{ flex: 1 }} />
              <span className="filter-val">{paperMinConf}%</span>
            </div>
          </div>
        </div>

        {/* Save + Test Connection side-by-side with status messages */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <button className="btn-primary btn-sm" onClick={savePaperSettings}
                  disabled={paperSaveStatus === 'saving'}>
            {paperSaveStatus === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <button className="btn-secondary btn-sm" onClick={testAlpacaConnection}
                  disabled={alpacaTestLoading}>
            {alpacaTestLoading ? 'Testing…' : 'Test Connection'}
          </button>
          {paperSaveStatus === 'ok'    && <span className="settings-ok">✓ Saved</span>}
          {paperSaveStatus === 'error' && <span className="settings-err">✗ Save failed</span>}
          {alpacaTestResult && alpacaTestResult !== 'error' && (
            <span className="settings-ok" style={{ fontSize: 12 }}>
              ✓ Connected · Equity ${parseFloat(alpacaTestResult.equity ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          )}
          {alpacaTestResult === 'error' && (
            <span className="settings-err" style={{ fontSize: 12 }}>✗ Connection failed — check credentials</span>
          )}
        </div>
      </SettingSection>

      {/* ── AI Provider ───────────────────────────────────────────────────── */}
      <SettingSection id="settings-ai-provider" title="AI Provider" icon="🧠">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Choose where AI analysis runs. <strong>Ollama</strong> is local (no internet, needs GPU/RAM).
          <strong> Groq</strong>, <strong>Gemini</strong>, and <strong>Mistral</strong> are cloud APIs.
          Changes take effect immediately, no restart needed.
        </p>

        <div className="settings-field">
          <label className="settings-label">Provider</label>
          <select
            value={llmProvider}
            onChange={e => {
              // Reset per-provider fields so a model/key typed for one
              // provider can never be silently saved against another.
              const provider = e.target.value
              setLlmProvider(provider)
              setUseEnvDefaults(false)
              setModelChoice('')
              setLlmModel('')
              setLlmApiKey('')
              setLlmBaseUrl('')
              setLlmApiKeySet(false)
              setLlmReasoningEffort('none')
              loadProviderSettings(provider).catch(() => {})
            }}
            className="settings-select"
          >
            <option value="ollama">🖥️ Ollama (local)</option>
            <option value="groq">⚡ Groq Cloud — free · console.groq.com</option>
            <option value="gemini">✨ Google Gemini — free · ai.google.dev</option>
            <option value="mistral">🌬️ Mistral AI · console.mistral.ai</option>
            <option value="custom">🔧 Custom OpenAI-compatible endpoint</option>
          </select>
        </div>

        {llmProvider !== 'custom' && (
          <button
            type="button"
            className={`settings-env-btn${useEnvDefaults ? ' active' : ''}`}
            onClick={() => {
              setUseEnvDefaults(v => !v)
              setLlmApiKey('')
              setShowLlmApiKey(false)
            }}
          >
            {useEnvDefaults ? '✓ Using environment defaults' : '↩ Load Environment Default Values'}
            <span className="settings-env-btn-sub">
              {useEnvDefaults ? '(click to clear and enter values manually)' : '(if set in .env — can be empty)'}
            </span>
          </button>
        )}

        {llmProvider !== 'ollama' && (
          <>
            <div className="settings-field">
              <label className="settings-label">API Key</label>
              <div className="settings-secret-field">
                <input
                  type={showLlmApiKey ? 'text' : 'password'}
                  value={llmApiKey || savedApiKeyMask}
                  onFocus={() => { if (!llmApiKey && savedApiKeyMask) setLlmApiKey('') }}
                  onChange={e => setLlmApiKey(e.target.value)}
                  disabled={envDefaultsActive}
                  placeholder={
                    envDefaultsActive
                      ? (llmApiKeyEnvSet ? 'Using key from .env' : 'No key set in .env')
                      : (llmApiKeySet ? 'Key saved — focus to replace it' : 'Paste your API key here')
                  }
                  className="settings-select"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="settings-secret-toggle"
                  onClick={() => setShowLlmApiKey(v => !v)}
                  title={showLlmApiKey ? 'Hide API key' : 'Show/hide typed key'}
                  aria-label={showLlmApiKey ? 'Hide API key' : 'Show API key'}
                >
                  {showLlmApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
              {!envDefaultsActive && llmApiKeySet && !llmApiKey && (
                <span className="text-dim" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                  ✓ API key is set — to rotate it, paste a new key above and save
                </span>
              )}
            </div>

            <div className="settings-field">
              <label className="settings-label">
                Model
                <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>(select or type a model ID)</span>
              </label>
              {llmProvider !== 'custom' && !customModelEntry && (
                <select
                  value={envDefaultsActive ? modelValue : modelSelectValue}
                  onChange={e => {
                    const value = e.target.value
                    setModelChoice(value)
                    if (value !== '__custom__') setLlmModel(value)
                  }}
                  disabled={envDefaultsActive}
                  className="settings-select"
                >
                  {modelOptions.map(modelOption => <option key={modelOption} value={modelOption}>{modelOption}</option>)}
                  <option value="__custom__">— type your own model —</option>
                </select>
              )}
              {(llmProvider === 'custom' || customModelEntry) && (
                <>
                  {customModelEntry && llmProvider !== 'custom' && (
                    <button
                      type="button"
                      className="settings-back-link"
                      onClick={() => {
                        const first = modelOptions[0] ?? ''
                        setModelChoice(first)
                        setLlmModel(first)
                      }}
                    >
                      ← back to model list
                    </button>
                  )}
                  <input
                    type="text"
                    value={envDefaultsActive ? modelValue : llmModel}
                    onChange={e => setLlmModel(e.target.value)}
                    disabled={envDefaultsActive}
                    placeholder="Type a model ID"
                    className="settings-select"
                  />
                </>
              )}
            </div>

            {supportsReasoning && (
              <div className="settings-field">
                <label className="settings-label">
                  Reasoning effort
                  <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>(only used by models that support it)</span>
                </label>
                <select
                  value={llmReasoningEffort}
                  onChange={e => setLlmReasoningEffort(e.target.value)}
                  className="settings-select"
                >
                  {REASONING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            )}

            {llmProvider === 'custom' && (
              <div className="settings-field">
                <label className="settings-label">Base URL</label>
                <input
                  type="text"
                  value={llmBaseUrl}
                  onChange={e => setLlmBaseUrl(e.target.value)}
                  placeholder="https://your-host/v1"
                  className="settings-select"
                />
              </div>
            )}
          </>
        )}

        {llmProvider === 'ollama' && (
          <>
            <div className="settings-field">
              <label className="settings-label">Model</label>
              {!customModelEntry && (
                <select
                  value={envDefaultsActive ? modelValue : modelSelectValue}
                  onChange={e => {
                    const value = e.target.value
                    setModelChoice(value)
                    if (value !== '__custom__') setModel(value)
                  }}
                  disabled={envDefaultsActive}
                  className="settings-select"
                >
                  {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
                  <option value="__custom__">— type your own model —</option>
                </select>
              )}
              {customModelEntry && (
                <>
                  <button
                    type="button"
                    className="settings-back-link"
                    onClick={() => {
                      const first = modelOptions[0] ?? ''
                      setModelChoice(first)
                      setModel(first)
                    }}
                  >
                    ← back to model list
                  </button>
                  <input
                    type="text"
                    value={envDefaultsActive ? modelValue : model}
                    onChange={e => setModel(e.target.value)}
                    disabled={envDefaultsActive}
                    placeholder="Type an Ollama model tag"
                    className="settings-select"
                  />
                </>
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
            <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>
              Match model size to GPU VRAM: 3b ≈ 3 GB · 7b ≈ 5 GB · 14b ≈ 10 GB.
              Pull new models: <code className="inline-code">docker exec ollama ollama pull &lt;model&gt;</code>
            </p>
          </>
        )}

        {/* ── Fallback provider (auto-used on HTTP 429 / quota) ──────────── */}
        <div className="settings-field" style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <label className="settings-label">
            Fallback provider
            <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>
              (auto-used when primary returns quota / HTTP 429)
            </span>
          </label>
          <select
            value={llmFallbackProvider}
            onChange={e => setLlmFallbackProvider(e.target.value)}
            className="settings-select"
          >
            <option value="">— disabled —</option>
            <option value="ollama">🖥️ Ollama (local)</option>
            <option value="groq">⚡ Groq Cloud</option>
            <option value="gemini">✨ Google Gemini</option>
            <option value="mistral">🌬️ Mistral AI</option>
            <option value="custom">🔧 Custom endpoint</option>
          </select>
        </div>
        {llmFallbackProvider && llmFallbackProvider !== llmProvider && (
          <div className="settings-field">
            <label className="settings-label">
              Fallback model
              <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>(leave blank for provider default)</span>
            </label>
            <input
              type="text"
              value={llmFallbackModel}
              onChange={e => setLlmFallbackModel(e.target.value)}
              placeholder="e.g. gemini-3.5-flash-lite"
              className="settings-select"
            />
          </div>
        )}

        <SaveRow
          status={llmStatus} errMsg={llmErr}
          onSave={llmProvider === 'ollama' ? saveOllama : saveLlm}
          label="Save AI provider settings"
        />
      </SettingSection>

      {/* ── AI Usage ─────────────────────────────────────────────────────── */}
      <SettingSection id="settings-usage" title="AI Usage" icon="⚡">
        <UsageSection usage={usage} onRefresh={onUsageRefresh} />
      </SettingSection>

      {/* ── Performance ───────────────────────────────────────────────────── */}
      <SettingSection id="settings-perf" title="Performance" icon="🚀">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Control parallelism for <strong>both live signal scanning and backtesting</strong>.
          Higher concurrency finishes faster but must stay within provider rate limits.
          Changes take effect immediately — no restart needed.
        </p>

        {/* Sliders */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Concurrent tickers</label>
              <span style={{ fontSize: 10, background: 'var(--accent)', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>Signals</span>
              <span style={{ fontSize: 10, background: 'var(--accent)', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>Backtest</span>
              <span style={{ fontWeight: 700, color: 'var(--accent)', minWidth: 24, textAlign: 'right' }}>{concTickers}</span>
            </div>
            <input type="range" min={1} max={20} value={concTickers}
              onChange={e => setConcTickers(Number(e.target.value))}
              style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
              <span>1 (sequential)</span><span>4 (default)</span><span>20</span>
            </div>
            <p className="text-dim" style={{ fontSize: 12, marginTop: 6 }}>
              How many tickers are analysed simultaneously. For <strong>signals</strong>: the
              scheduler's concurrency cap (controls how many TickerAgent calls run at once, each
              making one LLM call). For <strong>backtests</strong>: the replay thread pool size.
              With the OHLCV cache most data is instant — 4–8 is a good range.
            </p>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Concurrent LLM calls</label>
              <span style={{ fontSize: 10, background: 'var(--dim)', color: 'var(--bg)', borderRadius: 4, padding: '1px 6px' }}>Backtest only</span>
              <span style={{ fontWeight: 700, color: 'var(--accent)', minWidth: 24, textAlign: 'right' }}>{concLlm}</span>
            </div>
            <input type="range" min={1} max={10} value={concLlm}
              onChange={e => setConcLlm(Number(e.target.value))}
              style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
              <span>1</span><span>2 (default)</span><span>10</span>
            </div>
            <p className="text-dim" style={{ fontSize: 12, marginTop: 6 }}>
              Backtest LLM mode only. Max LLM requests in-flight simultaneously across all
              ticker threads. Signals don't need this — each TickerAgent already maps to one LLM
              call, so <em>Concurrent tickers</em> above is the effective limit for signals.
              Keep this ≤ your provider's RPM ÷ 15 to stay within rate limits.
            </p>
          </div>
        </div>

        <div className="settings-save-row" style={{ marginBottom: 20 }}>
          <button className="btn-primary btn-sm" onClick={savePerfSettings} disabled={perfSaveStatus === 'saving'}>
            {perfSaveStatus === 'saving' ? 'Saving…' : 'Save defaults'}
          </button>
          {perfSaveStatus === 'ok'    && <span className="settings-ok">✓ Saved</span>}
          {perfSaveStatus === 'error' && <span className="settings-err">✗ Save failed</span>}
        </div>

        {/* Rate limits reference */}
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>Rate limit reference</div>
        <table style={{ fontSize: 12, color: 'var(--dim)', borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', paddingBottom: 4, paddingRight: 16, color: 'var(--fg)' }}>Source</th>
              <th style={{ textAlign: 'left', paddingBottom: 4, color: 'var(--fg)' }}>Limit</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['yfinance', 'No official limit — 3–4 concurrent safe. Cache makes most calls instant.'],
              ['Finnhub (news)', '60 req/min free tier. Date-keyed cache = 1 call/ticker/day max.'],
              ['Gemini free', '15 RPM · 1 500 RPD · 1M TPM'],
              ['Groq', '30–60 RPM (model-dependent) — check console.groq.com'],
              ['OpenAI', 'Tier-dependent — check platform.openai.com/usage'],
              ['Mistral', '30 RPM · 500 RPD'],
              ['Ollama', 'Local inference — no external rate limits'],
            ].map(([src, lim]) => (
              <tr key={src}>
                <td style={{ padding: '4px 16px 4px 0', whiteSpace: 'nowrap', fontWeight: 500, color: 'var(--fg)' }}>{src}</td>
                <td style={{ padding: '4px 0' }}>{lim}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingSection>

      <SettingSection id="settings-cache" title="Data Cache" icon="💾">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Every market data fetch is stored permanently in the local database, keyed by
          ticker and date. The price, indicator, and news snapshot from each trading day
          is preserved exactly as seen — so backtests can replay the same market state
          without making network calls. OHLCV bars for completed sessions never change.
        </p>

        {/* Stats row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          {cacheStats ? (
            <>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', minWidth: 120, textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{cacheStats.entry_count}</div>
                <div style={{ fontSize: 11, color: 'var(--dim)' }}>cache entries</div>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', minWidth: 120, textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{cacheStats.total_kb} KB</div>
                <div style={{ fontSize: 11, color: 'var(--dim)' }}>stored</div>
              </div>
              {cacheStats.oldest && (
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>
                  Oldest: {cacheStats.oldest?.slice(0, 16).replace('T', ' ')}<br />
                  Newest: {cacheStats.newest?.slice(0, 16).replace('T', ' ')}
                </div>
              )}
              <button className="btn-sm" style={{ marginLeft: 'auto' }} onClick={loadCacheStats}>↻ Refresh</button>
            </>
          ) : cacheStatsErr ? (
            <span className="settings-err" style={{ fontSize: 12 }}>⚠ Could not load cache stats</span>
          ) : (
            <span className="text-dim" style={{ fontSize: 12 }}>Loading…</span>
          )}
        </div>

        {/* TTL reference */}
        <table style={{ fontSize: 12, color: 'var(--dim)', borderCollapse: 'collapse', marginBottom: 16, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 4, paddingRight: 16, color: 'var(--fg)' }}>Data type</th>
              <th style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 4, color: 'var(--fg)' }}>Cache TTL</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Price + fundamentals', '♾ Permanent (keyed by date)'],
              ['Technical indicators (RSI, MACD, …)', '♾ Permanent (keyed by date)'],
              ['News headlines (Finnhub)', '♾ Permanent (keyed by date)'],
              ['OHLCV bars (all windows)', '♾ Permanent (keyed by start/end/interval)'],
              ['Macro data (FRED / CAPE)', '6 hours / 24 hours (global, rarely changes)'],
              ['Balance sheet', '24 hours (daily, quarterly filings)'],
            ].map(([label, ttl]) => (
              <tr key={label}>
                <td style={{ padding: '3px 16px 3px 0' }}>{label}</td>
                <td style={{ padding: '3px 0', color: ttl.startsWith('♾') ? 'var(--green)' : undefined }}>{ttl}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Evict controls */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn-sm" onClick={() => evictCache(168)} disabled={cacheEvictStatus === 'clearing'}>
            Clear entries &gt; 7 days
          </button>
          <button className="btn-sm" onClick={() => evictCache(24)} disabled={cacheEvictStatus === 'clearing'}>
            Clear entries &gt; 24 h
          </button>
          <button className="btn-danger btn-sm" onClick={() => evictCache(1)} disabled={cacheEvictStatus === 'clearing'}>
            Clear all cache
          </button>
          {cacheEvictStatus === 'clearing' && <span className="text-dim" style={{ fontSize: 12 }}>Clearing…</span>}
          {cacheEvictStatus?.startsWith('ok:') && (
            <span className="settings-ok">✓ {cacheEvictStatus.split(':')[1]} entries removed</span>
          )}
          {cacheEvictStatus === 'error' && <span className="settings-err">✗ Evict failed</span>}
        </div>
      </SettingSection>

      {/* ── Data ──────────────────────────────────────────────────────────── */}
      <SettingSection id="settings-data" title="Data" icon="🗑️">
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
    </div>
  )
}

// ─── BacktestPage ─────────────────────────────────────────────────────────────

const BT_PRESETS = [
  { label: '30D', days: 30 },
  { label: '3M', days: 91 },
  { label: '6M', days: 182 },
  { label: '1Y', days: 365 },
  { label: '2Y', days: 730 },
]

function fmtPct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%' }
function fmtR(v)   { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'R' }
function fmtNum(v) { return v == null ? '—' : v.toLocaleString() }

// ─── Paper Trading Page ───────────────────────────────────────────────────────

function PaperTradingPage({ initialExpandedOrder = null, onExpandedOrderConsumed }) {
  const [account,   setAccount]   = useState(null)
  const [positions, setPositions] = useState([])
  const [orders,    setOrders]    = useState([])
  const [history,   setHistory]   = useState(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [orderFilter,    setOrderFilter]    = useState('all') // all | open | filled | cancelled
  const [cancelling,     setCancelling]     = useState({})
  const [expandedOrder,  setExpandedOrder]  = useState(null)
  const [expandedPos,    setExpandedPos]    = useState(null) // expanded open-position row
  const [pnlDays,        setPnlDays]        = useState(30)   // P&L chart day window
  const initialConsumed = useRef(false)

  // When navigated from sidebar, auto-expand and scroll to the target order
  useEffect(() => {
    if (initialExpandedOrder && orders.length > 0 && !initialConsumed.current) {
      initialConsumed.current = true
      setExpandedOrder(initialExpandedOrder)
      setOrderFilter('all')
      onExpandedOrderConsumed?.()
      setTimeout(() => {
        document.getElementById(`paper-order-${initialExpandedOrder}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 150)
    }
  }, [initialExpandedOrder, orders, onExpandedOrderConsumed])

  const fmtMoney = (v, dp = 2) =>
    v == null ? '—' : `$${parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
  const fmtPct   = (v) => v == null ? '' : `${v >= 0 ? '+' : ''}${parseFloat(v).toFixed(2)}%`
  const fmtPnl   = (v) => v == null ? '—' : (
    <span style={{ color: parseFloat(v) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
      {parseFloat(v) >= 0 ? '+' : ''}{fmtMoney(v)}
    </span>
  )

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [accR, posR, ordR, hisR] = await Promise.all([
        fetch(`${API}/paper/account`,  { headers: getAuthHeaders() }),
        fetch(`${API}/paper/positions`,{ headers: getAuthHeaders() }),
        fetch(`${API}/paper/orders?limit=200`, { headers: getAuthHeaders() }),
        fetch(`${API}/paper/history?period=1M&timeframe=1D`, { headers: getAuthHeaders() }),
      ])
      if (accR.ok) { const d = await accR.json(); setAccount(d.account ?? null) }
      if (posR.ok) setPositions((await posR.json()).positions ?? [])
      if (ordR.ok) setOrders((await ordR.json()).orders ?? [])
      if (hisR.ok) setHistory(await hisR.json())
    } catch { setError('Failed to load paper trading data') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const cancelOrder = async (dbId, alpacaId) => {
    setCancelling(c => ({ ...c, [dbId]: true }))
    try {
      await fetch(`${API}/paper/orders/${dbId}/cancel`, { method: 'POST', headers: getAuthHeaders() })
      await load()
    } finally { setCancelling(c => { const n={...c}; delete n[dbId]; return n }) }
  }

  // ── Equity sparkline (SVG) ───────────────────────────────────────────────────
  const EquityChart = () => {
    if (!history?.equity?.length) return <div style={{ color: 'var(--dim)', fontSize: 12 }}>No portfolio history yet</div>
    const equity = history.equity.filter(v => v != null)
    const ts     = history.timestamp ?? []
    if (equity.length < 2) return null
    const W = 600, H = 100, pad = 4
    const min = Math.min(...equity), max = Math.max(...equity)
    const range = max - min || 1
    const pts = equity.map((v, i) => {
      const x = pad + (i / (equity.length - 1)) * (W - pad * 2)
      const y = H - pad - ((v - min) / range) * (H - pad * 2)
      return `${x},${y}`
    }).join(' ')
    const isUp = equity[equity.length - 1] >= equity[0]
    const color = isUp ? '#34d399' : '#f87171'
    const startDate = ts[0]  ? new Date(ts[0]  * 1000).toLocaleDateString() : ''
    const endDate   = ts[ts.length - 1] ? new Date(ts[ts.length - 1] * 1000).toLocaleDateString() : ''
    const pnl = equity[equity.length - 1] - equity[0]
    const pnlPct = equity[0] ? ((pnl / equity[0]) * 100).toFixed(2) : '0.00'
    return (
      <div style={{ padding: '10px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--dim)' }}>{startDate} – {endDate}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color }}>
            {pnl >= 0 ? '+' : ''}{fmtMoney(pnl)} ({pnl >= 0 ? '+' : ''}{pnlPct}%)
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }}>
          <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
          <line x1={pad} y1={H - pad - ((equity[0] - min) / range) * (H - pad * 2)}
                x2={W - pad} y2={H - pad - ((equity[0] - min) / range) * (H - pad * 2)}
                stroke="#444" strokeWidth="1" strokeDasharray="4 3" />
        </svg>
      </div>
    )
  }

  const statusColor = (s) => ({
    filled: 'var(--green)', partially_filled: 'var(--green)',
    cancelled: 'var(--dim)', canceled: 'var(--dim)',
    expired: 'var(--dim)', rejected: '#f87171',
    pending_new: '#fbbf24', accepted: '#fbbf24', held: '#fbbf24',
  }[s] ?? 'var(--dim)')

  const filteredOrders = orders.filter(o => {
    if (orderFilter === 'open')      return ['pending_new','accepted','held','partially_filled'].includes(o.status)
    if (orderFilter === 'filled')    return ['filled','partially_filled'].includes(o.status)
    if (orderFilter === 'cancelled') return ['cancelled','canceled','expired','rejected'].includes(o.status)
    return true
  })

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>📈 Paper Trading</h2>
        <button className="btn-ghost" onClick={load} disabled={loading} style={{ fontSize: 12 }}>
          {loading ? '↻ Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && <div style={{ fontSize: 12, color: '#f87171' }}>{error}</div>}

      {/* Account stats panel */}
      {account && (() => {
        const dayPnl    = account.day_pnl ?? 0
        const dayPnlPct = account.day_pnl_pct ?? 0
        const dayColor  = dayPnl >= 0 ? 'var(--green)' : 'var(--red)'
        const tile = (label, value, sub) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div>
            {sub && <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>{sub}</div>}
          </div>
        )
        return (
          <>
            {/* Primary row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {tile('Portfolio Value', fmtMoney(account.portfolio_value ?? account.equity))}
              {tile('Equity',         fmtMoney(account.equity))}
              {tile('Day P&L',
                <span style={{ color: dayColor, fontWeight: 700 }}>
                  {dayPnl >= 0 ? '+' : ''}{fmtMoney(dayPnl)}
                </span>,
                <span style={{ color: dayColor }}>{dayPnl >= 0 ? '+' : ''}{parseFloat(dayPnlPct).toFixed(2)}%</span>
              )}
              {tile('Cash',          fmtMoney(account.cash))}
              {tile('Buying Power',  fmtMoney(account.buying_power),
                account.multiplier ? `${account.multiplier}× margin` : undefined)}
            </div>
            {/* Secondary row — exposure + margin */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {tile('Long Exposure',       fmtMoney(account.long_market_value),  'open long positions')}
              {tile('Short Exposure',      fmtMoney(account.short_market_value), 'open short positions')}
              {tile('Maintenance Margin',  fmtMoney(account.maintenance_margin), 'min equity required')}
              {tile('Daytrade Count',      account.daytrade_count ?? 0,           'PDT limit: 3 in 5 days')}
            </div>
          </>
        )
      })()}

      {/* Equity curve */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Portfolio Equity (1 month)</div>
        <EquityChart />
      </div>

      {/* Insights — always shown when orders exist */}
      {orders.length > 0 && (() => {
        const cardStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', flex: '1 1 240px', minWidth: 0 }
        const titleStyle = { fontSize: 12, fontWeight: 700, marginBottom: 10 }
        const dimStyle = { fontSize: 10, color: 'var(--dim)' }
        const closed = orders.filter(o => o.realized_pnl != null)

        // ── Orders by status (all orders) ─────────────────────────────────────
        const statusGroups = Object.entries(
          orders.reduce((acc, o) => {
            const s = (o.status ?? 'unknown').replace(/_/g, ' ')
            acc[s] = (acc[s] ?? 0) + 1; return acc
          }, {})
        ).map(([name, value]) => ({ name, value }))

        // ── Max potential gain / max potential loss per order (all pending) ────
        const pendingOrders = orders.filter(o => o.entry_price && o.stop_price && o.take_profit_price)
        const riskRewardData = pendingOrders.map(o => {
          const qty = o.qty != null ? parseFloat(o.qty) : Math.floor((o.notional ?? 500) / o.entry_price)
          const loss = Math.abs(o.entry_price - o.stop_price) * qty
          const gain = Math.abs(o.take_profit_price - o.entry_price) * qty
          return { ticker: `${o.ticker} ${o.side === 'buy' ? '▲' : '▼'}`, loss: parseFloat(loss.toFixed(2)), gain: parseFloat(gain.toFixed(2)) }
        })

        // ── Confidence distribution (all orders) ─────────────────────────────
        const confData = orders
          .filter(o => o.signal_confidence != null)
          .map(o => ({ ticker: o.ticker, conf: o.signal_confidence }))
          .sort((a, b) => b.conf - a.conf)

        // ── P&L by ticker (only closed) ───────────────────────────────────────
        const pnlByTicker = closed.length > 0 ? Object.entries(
          closed.reduce((acc, o) => { acc[o.ticker] = (acc[o.ticker] ?? 0) + parseFloat(o.realized_pnl ?? 0); return acc }, {})
        ).map(([ticker, pnl]) => ({ ticker, pnl: parseFloat(pnl.toFixed(2)) })).sort((a, b) => b.pnl - a.pnl) : []

        // ── Win/Loss (only closed) ────────────────────────────────────────────
        const wins   = closed.filter(o => (o.realized_pnl ?? 0) > 0).length
        const losses = closed.filter(o => (o.realized_pnl ?? 0) <= 0).length
        const pieData = [
          { name: `Wins (${wins})`,     value: wins,   fill: '#34d399' },
          { name: `Losses (${losses})`, value: losses, fill: '#f87171' },
        ].filter(d => d.value > 0)

        return (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>

            {/* Orders by status donut */}
            <div style={cardStyle}>
              <div style={titleStyle}>Orders by Status</div>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={statusGroups} cx="50%" cy="50%" innerRadius={35} outerRadius={60}
                    dataKey="value" paddingAngle={2} labelLine={false}
                    label={({ name, value }) => `${value}`}>
                    {statusGroups.map((_, i) => (
                      <Cell key={i} fill={['#fbbf24','#34d399','#f87171','#60a5fa','#a78bfa'][i % 5]} />
                    ))}
                  </Pie>
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Max gain vs max loss per order */}
            {riskRewardData.length > 0 && (() => {
              const totalGain = riskRewardData.reduce((s, o) => s + o.gain, 0)
              const totalLoss = riskRewardData.reduce((s, o) => s + o.loss, 0)
              const net = totalGain - totalLoss
              return (
                <div style={cardStyle}>
                  <div style={titleStyle}>Max Gain / Max Loss per Order <span style={dimStyle}>(all open)</span></div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={riskRewardData} barCategoryGap="20%" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <XAxis dataKey="ticker" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={44} />
                      <Tooltip formatter={(v, n) => [`$${v.toFixed(2)}`, n === 'gain' ? 'Max gain' : 'Max loss']} />
                      <ReferenceLine y={0} stroke="var(--border)" />
                      <Bar dataKey="gain" fill="#34d399" radius={[3,3,0,0]} name="gain" />
                      <Bar dataKey="loss" fill="#f87171" radius={[3,3,0,0]} name="loss" />
                    </BarChart>
                  </ResponsiveContainer>
                  {/* Cumulative totals */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4, fontSize: 11 }}>
                    <div style={{ display: 'flex', gap: 16 }}>
                      <span>Total max gain: <strong style={{ color: '#34d399' }}>+${totalGain.toFixed(2)}</strong></span>
                      <span>Total max loss: <strong style={{ color: '#f87171' }}>−${totalLoss.toFixed(2)}</strong></span>
                    </div>
                    <span style={{ fontWeight: 700, color: net >= 0 ? '#34d399' : '#f87171' }}>
                      Net: {net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(2)}
                    </span>
                  </div>
                </div>
              )
            })()}

            {/* Confidence per order */}
            {confData.length > 0 && (
              <div style={cardStyle}>
                <div style={titleStyle}>Signal Confidence per Order</div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={confData} barCategoryGap="20%" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <XAxis dataKey="ticker" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} domain={[60, 100]} width={36} />
                    <Tooltip formatter={v => [`${v}%`, 'Confidence']} />
                    <ReferenceLine y={75} stroke="var(--border)" strokeDasharray="3 2" label={{ value: 'floor', position: 'right', fontSize: 9, fill: 'var(--dim)' }} />
                    <Bar dataKey="conf" radius={[3,3,0,0]}>
                      {confData.map((entry, i) => (
                        <Cell key={i} fill={entry.conf >= 85 ? '#34d399' : entry.conf >= 75 ? '#fbbf24' : '#f87171'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={dimStyle}>Dashed = confidence floor</div>
              </div>
            )}

            {/* Realised P&L by ticker — only when closed orders exist */}
            {pnlByTicker.length > 0 && (
              <div style={cardStyle}>
                <div style={titleStyle}>Realised P&L by Ticker</div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={pnlByTicker} barCategoryGap="30%" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <XAxis dataKey="ticker" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={40} />
                    <Tooltip formatter={v => [`$${v.toFixed(2)}`, 'P&L']} />
                    <ReferenceLine y={0} stroke="var(--border)" />
                    <Bar dataKey="pnl" radius={[3,3,0,0]}>
                      {pnlByTicker.map((entry, i) => <Cell key={i} fill={entry.pnl >= 0 ? '#34d399' : '#f87171'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Win / Loss donut — only when closed orders exist */}
            {pieData.length > 0 && (
              <div style={cardStyle}>
                <div style={titleStyle}>Win / Loss <span style={dimStyle}>({closed.length > 0 ? ((wins/closed.length)*100).toFixed(0) : 0}% win rate)</span></div>
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={65}
                      dataKey="value" paddingAngle={2} labelLine={false}
                      label={({ percent }) => `${(percent*100).toFixed(0)}%`}>
                      {pieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                    </Pie>
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

          </div>
        )
      })()}

      {/* Realised P&L over time */}
      {(() => {
        const cutoff = pnlDays === 0 ? null : new Date(Date.now() - pnlDays * 86400000)
        const closed = orders
          .filter(o => o.realized_pnl != null && (o.filled_at || o.closed_at))
          .filter(o => !cutoff || new Date(o.filled_at || o.closed_at) >= cutoff)
          .sort((a, b) => new Date(a.filled_at || a.closed_at) - new Date(b.filled_at || b.closed_at))

        let cum = 0
        const chartData = closed.map(o => {
          cum += parseFloat(o.realized_pnl ?? 0)
          return {
            label: `${o.ticker} ${new Date(o.filled_at || o.closed_at).toLocaleDateString([], { month:'short', day:'numeric' })}`,
            pnl:   parseFloat(parseFloat(o.realized_pnl).toFixed(2)),
            cum:   parseFloat(cum.toFixed(2)),
          }
        })

        const DAY_OPTS = [7, 30, 90, 0]
        const isUp = chartData.length ? chartData[chartData.length - 1].cum >= 0 : true
        const lineColor = isUp ? '#34d399' : '#f87171'

        return (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>Realised P&L</span>
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {DAY_OPTS.map(d => (
                  <button key={d} onClick={() => setPnlDays(d)}
                    style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 10, cursor: 'pointer',
                      background: pnlDays === d ? 'var(--accent)' : 'transparent',
                      color: pnlDays === d ? '#fff' : 'var(--dim)',
                      border: `1px solid ${pnlDays === d ? 'var(--accent)' : 'var(--border)'}`,
                      fontWeight: pnlDays === d ? 700 : 400,
                    }}
                  >{d === 0 ? 'All' : `${d}D`}</button>
                ))}
              </div>
            </div>
            {chartData.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--dim)', padding: '20px 0', textAlign: 'center' }}>
                No closed orders in the selected period.
              </div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={lineColor} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="label" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={44} />
                    <Tooltip
                      formatter={(v, n) => [`$${parseFloat(v).toFixed(2)}`, n === 'cum' ? 'Cumulative P&L' : 'Trade P&L']}
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
                    />
                    <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 2" />
                    <Area type="monotone" dataKey="cum" stroke={lineColor} strokeWidth={2}
                      fill="url(#pnlGrad)" name="cum" dot={{ r: 3, fill: lineColor }} />
                  </AreaChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 20, borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4, fontSize: 11 }}>
                  <span>Trades: <strong>{chartData.length}</strong></span>
                  <span>Total P&L: <strong style={{ color: lineColor }}>{cum >= 0 ? '+' : ''}${cum.toFixed(2)}</strong></span>
                  <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>{pnlDays === 0 ? 'All time' : `Last ${pnlDays} days`}</span>
                </div>
              </>
            )}
          </div>
        )
      })()}

      {/* Open positions — P&L over time line chart */}
      {positions.length > 0 && (() => {
        // Match each position to its DB order to get the placement timestamp
        const posWithOrders = positions.map(p => {
          const ticker = p.symbol ?? p.ticker
          const isLong = parseFloat(p.qty ?? 0) >= 0
          const side   = isLong ? 'buy' : 'sell'
          const ord    = orders.find(o => o.ticker === ticker && o.side === side &&
            ['pending_new','accepted','held','partially_filled'].includes(o.status))
            ?? orders.find(o => o.ticker === ticker && o.side === side)
          return { ticker, upnl: parseFloat(p.unrealized_pl ?? 0), startIso: ord?.created_at ?? null }
        }).filter(p => p.startIso != null)

        if (posWithOrders.length === 0) return null

        const now = new Date()
        // Build time axis: each position's open date + current time (de-duped, sorted)
        const axisTimes = [...new Map(
          [...posWithOrders.map(p => p.startIso), now.toISOString()]
            .map(iso => [new Date(iso).getTime(), new Date(iso)])
        ).values()].sort((a, b) => a - b)

        // For each time point compute each ticker's linearly-interpolated P&L (0 → current)
        const chartData = axisTimes.map(t => {
          const point = {
            label: t >= now
              ? 'Now'
              : t.toLocaleDateString([], { month: 'short', day: 'numeric' })
                + ' ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          }
          let total = 0
          posWithOrders.forEach(({ ticker, upnl, startIso }) => {
            const start = new Date(startIso)
            if (t < start) {
              point[ticker] = null
            } else {
              const progress = now > start ? (t - start) / (now - start) : 1
              const val = parseFloat((upnl * progress).toFixed(2))
              point[ticker] = val
              total += val
            }
          })
          point['Total'] = parseFloat(total.toFixed(2))
          return point
        })

        const totalUpnl  = posWithOrders.reduce((s, p) => s + p.upnl, 0)
        const totalColor = totalUpnl >= 0 ? '#34d399' : '#f87171'
        const COLORS     = ['#60a5fa', '#fbbf24', '#a78bfa', '#22d3ee', '#fb923c', '#f472b6']

        return (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>Open Positions — Unrealised P&L over Time</span>
              <span style={{ fontWeight: 700, color: totalColor, fontSize: 13 }}>
                {totalUpnl >= 0 ? '+' : ''}{fmtMoney(totalUpnl)} total
              </span>
            </div>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false}
                  tickFormatter={v => `$${v}`} width={44} />
                <Tooltip
                  formatter={(v, n) => v != null
                    ? [`${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`, n]
                    : [null, n]}
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
                />
                <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 2" />
                {posWithOrders.map(({ ticker }, i) => (
                  <Line key={ticker} type="monotone" dataKey={ticker}
                    stroke={COLORS[i % COLORS.length]} strokeWidth={1.5}
                    dot={{ r: 3 }} connectNulls={false} />
                ))}
                {/* Aggregate total — dashed, thicker */}
                <Line type="monotone" dataKey="Total"
                  stroke={totalColor} strokeWidth={2.5} strokeDasharray="5 3"
                  dot={{ r: 4, fill: totalColor }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 4 }}>
              Each line = linear estimate from $0 at order placement → current unrealised P&amp;L.
              Dashed = portfolio total.
            </div>
          </div>
        )
      })()}

      {/* Open positions table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>
          Open Positions <span style={{ color: 'var(--dim)', fontWeight: 400 }}>({positions.length})</span>
          {positions.length > 0 && <span style={{ fontSize: 10, color: 'var(--dim)', fontWeight: 400, marginLeft: 6 }}>· click a row for order details</span>}
        </div>
        {positions.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--dim)' }}>No open positions.</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Ticker</th><th>Side</th><th>Qty</th><th>Avg Entry</th>
                    <th>Current Price</th><th>Market Value</th><th>Unrealised P&L</th><th>P&L %</th>
                    <th>Stop</th><th>Target</th><th>Conf %</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => {
                    const ticker   = p.symbol ?? p.ticker
                    const isLong   = parseFloat(p.qty ?? 0) >= 0
                    const side     = isLong ? 'buy' : 'sell'
                    // Find the most-recent matching order for stop/target/signal info
                    const matchOrd = orders.find(o => o.ticker === ticker && o.side === side &&
                      ['pending_new','accepted','held','partially_filled'].includes(o.status))
                      ?? orders.find(o => o.ticker === ticker && o.side === side)
                    const isExpPos = expandedPos === i
                    const qty      = Math.abs(parseFloat(p.qty ?? 0))
                    const upnl     = parseFloat(p.unrealized_pl ?? 0)
                    const upnlPct  = p.unrealized_plpc != null ? parseFloat(p.unrealized_plpc) * 100 : null
                    const upnlColor = upnl >= 0 ? 'var(--green)' : 'var(--red)'
                    // Risk / reward based on matched order
                    const riskPer  = matchOrd?.entry_price != null && matchOrd?.stop_price != null
                      ? Math.abs(matchOrd.entry_price - matchOrd.stop_price) : null
                    const rewPer   = matchOrd?.entry_price != null && matchOrd?.take_profit_price != null
                      ? Math.abs(matchOrd.take_profit_price - matchOrd.entry_price) : null
                    const maxLoss  = riskPer != null ? riskPer * qty : null
                    const maxGain  = rewPer  != null ? rewPer  * qty : null
                    return (
                      <Fragment key={i}>
                        <tr style={{ cursor: matchOrd ? 'pointer' : 'default' }}
                          onClick={() => matchOrd && setExpandedPos(isExpPos ? null : i)}>
                          <td style={{ width: 20, color: 'var(--dim)', fontSize: 11, userSelect: 'none' }}>
                            {matchOrd ? (isExpPos ? '▾' : '▸') : ''}
                          </td>
                          <td><span className="badge-ticker">{ticker}</span></td>
                          <td><span className={`badge ${isLong ? 'long' : 'short'}`}>{isLong ? '▲ LONG' : '▼ SHORT'}</span></td>
                          <td>{qty}</td>
                          <td>{fmtMoney(p.avg_entry_price)}</td>
                          <td>{fmtMoney(p.current_price)}</td>
                          <td>{fmtMoney(p.market_value)}</td>
                          <td>
                            <span style={{ color: upnlColor, fontWeight: 600 }}>
                              {upnl >= 0 ? '+' : ''}{fmtMoney(upnl)}
                            </span>
                          </td>
                          <td style={{ color: upnlColor }}>
                            {upnlPct != null ? `${upnl >= 0 ? '+' : ''}${upnlPct.toFixed(2)}%` : '—'}
                          </td>
                          <td>
                            {matchOrd?.stop_price != null ? (
                              <div style={{ lineHeight: 1.4 }}>
                                <span style={{ color: 'var(--red)' }}>{fmtMoney(matchOrd.stop_price)}</span>
                                {maxLoss != null && <div style={{ fontSize: 10, color: 'var(--red)', opacity: 0.8 }}>−{fmtMoney(maxLoss)}</div>}
                              </div>
                            ) : '—'}
                          </td>
                          <td>
                            {matchOrd?.take_profit_price != null ? (
                              <div style={{ lineHeight: 1.4 }}>
                                <span style={{ color: 'var(--green)' }}>{fmtMoney(matchOrd.take_profit_price)}</span>
                                {maxGain != null && <div style={{ fontSize: 10, color: 'var(--green)', opacity: 0.8 }}>+{fmtMoney(maxGain)}</div>}
                              </div>
                            ) : '—'}
                          </td>
                          <td>{matchOrd?.signal_confidence != null ? `${matchOrd.signal_confidence.toFixed(0)}%` : '—'}</td>
                        </tr>
                        {/* Expanded position detail panel */}
                        {isExpPos && matchOrd && (
                          <tr style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}>
                            <td colSpan={12} style={{ padding: '10px 18px' }}>
                              <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap', fontSize: 11 }}>
                                {/* Position metrics */}
                                <div style={{ paddingRight: 24 }}>
                                  <div style={{ fontSize: 9, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Position</div>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 2 }}>
                                    {[
                                      ['Shares',     <span style={{ fontWeight: 700 }}>{qty}</span>],
                                      ['Avg Entry',  fmtMoney(p.avg_entry_price)],
                                      ['Mkt Value',  fmtMoney(p.market_value)],
                                      ['Unrealised', <span style={{ color: upnlColor, fontWeight: 700 }}>{upnl >= 0 ? '+' : ''}{fmtMoney(upnl)}</span>],
                                      ['Cost Basis', fmtMoney(parseFloat(p.avg_entry_price ?? 0) * qty)],
                                    ].map(([label, val], idx) => (
                                      <Fragment key={idx}>
                                        <span style={{ color: 'var(--dim)' }}>{label}</span>
                                        <span>{val}</span>
                                      </Fragment>
                                    ))}
                                  </div>
                                </div>
                                {/* Order bracket */}
                                <div style={{ paddingLeft: 24, paddingRight: 24, borderLeft: '1px solid var(--border)' }}>
                                  <div style={{ fontSize: 9, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Bracket Order</div>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 2 }}>
                                    {[
                                      ['Entry',      fmtMoney(matchOrd.entry_price)],
                                      ['Stop',       <span style={{ color: 'var(--red)' }}>{fmtMoney(matchOrd.stop_price)}</span>],
                                      ['Target',     <span style={{ color: 'var(--green)' }}>{fmtMoney(matchOrd.take_profit_price)}</span>],
                                      ['Max Loss',   maxLoss != null ? <span style={{ color: 'var(--red)', fontWeight: 700 }}>−{fmtMoney(maxLoss)}</span> : '—'],
                                      ['Max Gain',   maxGain != null ? <span style={{ color: 'var(--green)', fontWeight: 700 }}>+{fmtMoney(maxGain)}</span> : '—'],
                                      ['R:R',        riskPer && rewPer ? <span style={{ fontWeight: 700 }}>{(rewPer / riskPer).toFixed(1)}×</span> : '—'],
                                      ['Status',     <span style={{ fontSize: 10, fontWeight: 700, color: statusColor(matchOrd.status), textTransform: 'uppercase' }}>{(matchOrd.status ?? '—').replace(/_/g,' ')}</span>],
                                    ].map(([label, val], idx) => (
                                      <Fragment key={idx}>
                                        <span style={{ color: 'var(--dim)' }}>{label}</span>
                                        <span>{val}</span>
                                      </Fragment>
                                    ))}
                                  </div>
                                </div>
                                {/* Signal origin */}
                                <div style={{ paddingLeft: 24, borderLeft: '1px solid var(--border)' }}>
                                  <div style={{ fontSize: 9, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Signal</div>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 2 }}>
                                    {(() => {
                                      const hasAi = (matchOrd.signal_source ?? '').split('+').some(s => s.trim() === 'ai')
                                      return [
                                        ['Conf',    <span style={{ fontWeight: 700 }}>{matchOrd.signal_confidence != null ? `${matchOrd.signal_confidence.toFixed(0)}%` : '—'}</span>],
                                        ['Mode',    <span style={{
                                          fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 3,
                                          background: hasAi ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--dim) 10%, transparent)',
                                          color: hasAi ? 'var(--accent)' : 'var(--dim)',
                                          border: `1px solid ${hasAi ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--dim) 20%, transparent)'}`,
                                        }}>{hasAi ? '🤖 LLM' : '📐 Rules'}</span>],
                                        ['Sources', <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                          {(matchOrd.signal_source ?? '—').split('+').map((s, idx2) => <span key={idx2}>{s.trim()}</span>)}
                                        </span>],
                                        ['Placed',  matchOrd.created_at ? new Date(matchOrd.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'],
                                      ].map(([label, val], idx) => (
                                        <Fragment key={idx}>
                                          <span style={{ color: 'var(--dim)' }}>{label}</span>
                                          <span>{val}</span>
                                        </Fragment>
                                      ))
                                    })()}
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </div>

      {/* Orders table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Orders</span>
          <span style={{ fontSize: 11, color: 'var(--dim)' }}>({filteredOrders.length})</span>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {['all','open','filled','cancelled'].map(f => (
              <button key={f} onClick={() => setOrderFilter(f)}
                style={{
                  fontSize: 10, padding: '2px 9px', borderRadius: 12, cursor: 'pointer', textTransform: 'capitalize',
                  background: orderFilter === f ? 'var(--accent)' : 'transparent',
                  color: orderFilter === f ? '#fff' : 'var(--dim)',
                  border: `1px solid ${orderFilter === f ? 'var(--accent)' : 'var(--border)'}`,
                  fontWeight: orderFilter === f ? 700 : 400,
                }}
              >{f}</button>
            ))}
          </div>
        </div>
        {filteredOrders.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--dim)' }}>No orders yet.</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Ticker</th><th>Direction</th><th>Status</th>
                    <th>Position Size</th><th>Entry</th><th>Stop</th><th>Take Profit</th>
                    <th>Filled @</th><th>Realised P&L</th>
                    <th>Conf %</th><th>Source</th><th>Placed</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map(o => {
                    const isOpen = ['pending_new','accepted','held','partially_filled'].includes(o.status)
                    // Derive whole-share qty (same formula used when placing the order).
                    // No max(1,...) here — if floor < 1 the order should never have been placed.
                    const sharesQty  = o.qty != null
                      ? parseFloat(o.qty)
                      : (o.entry_price ? Math.floor((o.notional ?? 500) / o.entry_price) : null)
                    const actualCost = sharesQty != null && o.entry_price ? sharesQty * o.entry_price : null
                    // Per-position risk / reward in $
                    const isLong  = o.side === 'buy'
                    const riskPer = o.entry_price != null && o.stop_price != null
                      ? Math.abs(o.entry_price - o.stop_price) : null
                    const rewPer  = o.entry_price != null && o.take_profit_price != null
                      ? Math.abs(o.take_profit_price - o.entry_price) : null
                    const maxLoss = riskPer != null && sharesQty != null ? riskPer * sharesQty : null
                    const maxGain = rewPer  != null && sharesQty != null ? rewPer  * sharesQty : null
                    const rr      = maxLoss && maxGain ? (maxGain / maxLoss).toFixed(1) : null
                    const isExpanded = expandedOrder === o.id
                    const fmtTs = (iso) => iso ? new Date(iso).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'
                    return (
                      <Fragment key={o.id}>
                      <tr
                        id={`paper-order-${o.id}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedOrder(isExpanded ? null : o.id)}
                      >
                        <td style={{ width: 20, color: 'var(--dim)', fontSize: 11, userSelect: 'none' }}>
                          {isExpanded ? '▾' : '▸'}
                        </td>
                        <td><span className="badge-ticker">{o.ticker}</span></td>
                        <td>
                          <span className={`badge ${o.side === 'buy' ? 'long' : 'short'}`}>
                            {o.side === 'buy' ? '▲ LONG' : '▼ SHORT'}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: 10, fontWeight: 700, color: statusColor(o.status), textTransform: 'uppercase', display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                            {(o.status ?? '—').replace(/_/g,' ').split(' ').map((w, i) => <span key={i}>{w}</span>)}
                          </span>
                        </td>
                        {/* Position size: whole shares + actual cost */}
                        <td title={`Target: $${o.notional ?? '—'} → ${sharesQty ?? '?'} whole share(s) @ ${fmtMoney(o.entry_price)}`}>
                          <div style={{ lineHeight: 1.4 }}>
                            <span style={{ fontWeight: 700 }}>{sharesQty ?? '—'} shares</span>
                            {actualCost != null && (
                              <div style={{ fontSize: 10, color: 'var(--dim)' }}>{fmtMoney(actualCost)}</div>
                            )}
                          </div>
                        </td>
                        <td>{fmtMoney(o.entry_price)}</td>
                        <td>
                          <div style={{ lineHeight: 1.4 }}>
                            <span style={{ color: 'var(--red)' }}>{fmtMoney(o.stop_price)}</span>
                            {maxLoss != null && (
                              <div style={{ fontSize: 10, color: 'var(--red)', opacity: 0.8 }}>−{fmtMoney(maxLoss)}</div>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ lineHeight: 1.4 }}>
                            <span style={{ color: 'var(--green)' }}>{fmtMoney(o.take_profit_price)}</span>
                            {maxGain != null && (
                              <div style={{ fontSize: 10, color: 'var(--green)', opacity: 0.8 }}>+{fmtMoney(maxGain)}</div>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ lineHeight: 1.4 }}>
                            {fmtMoney(o.filled_avg_price)}
                            {rr != null && <div style={{ fontSize: 10, color: 'var(--dim)' }}>R:R {rr}×</div>}
                          </div>
                        </td>
                        <td>{fmtPnl(o.realized_pnl)}</td>
                        <td>{o.signal_confidence != null ? `${o.signal_confidence.toFixed(0)}%` : '—'}</td>
                        <td className="text-dim" style={{ fontSize: 10 }}>
                          {(o.signal_source ?? '—').split('+').map((s, i) => (
                            <div key={i}>{s.trim()}</div>
                          ))}
                        </td>
                        <td className="ts" style={{ fontSize: 10, lineHeight: 1.4 }}>
                          {o.created_at ? (
                            <>
                              <div>{new Date(o.created_at).toLocaleDateString([], { month:'short', day:'numeric' })}</div>
                              <div>{new Date(o.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</div>
                            </>
                          ) : '—'}
                        </td>
                        <td>
                          {isOpen && (
                            <button
                              onClick={() => cancelOrder(o.id, o.alpaca_order_id)}
                              disabled={cancelling[o.id]}
                              style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
                                background: 'color-mix(in srgb, var(--red) 12%, transparent)',
                                border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
                                color: 'var(--red)', fontWeight: 600 }}
                            >
                              {cancelling[o.id] ? '…' : 'Cancel'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {/* Expanded detail row */}
                      {isExpanded && (
                        <tr style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}>
                          <td colSpan={14} style={{ padding: '10px 18px' }}>
                            {/* Tight 3-column layout — each column is a definition grid (label · value side-by-side) */}
                            <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap', fontSize: 11 }}>

                              {/* Trade math */}
                              <div style={{ paddingRight: 24 }}>
                                <div style={{ fontSize: 9, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Trade Math</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 2 }}>
                                  {[
                                    ['Shares',          <span style={{ fontWeight: 700 }}>{sharesQty ?? '—'}</span>],
                                    ['Invested',        fmtMoney(actualCost)],
                                    ['Risk/share',      <span style={{ color: 'var(--red)' }}>{riskPer != null ? `−${fmtMoney(riskPer)}` : '—'}</span>],
                                    ['Reward/share',    <span style={{ color: 'var(--green)' }}>{rewPer != null ? `+${fmtMoney(rewPer)}` : '—'}</span>],
                                    ['Max loss',        <span style={{ color: 'var(--red)', fontWeight: 700 }}>{maxLoss != null ? `−${fmtMoney(maxLoss)}` : '—'}</span>],
                                    ['Max gain',        <span style={{ color: 'var(--green)', fontWeight: 700 }}>{maxGain != null ? `+${fmtMoney(maxGain)}` : '—'}</span>],
                                    ['R:R',             <span style={{ fontWeight: 700 }}>{rr != null ? `${rr}×` : '—'}</span>],
                                  ].map(([label, val], idx) => (
                                    <Fragment key={idx}>
                                      <span style={{ color: 'var(--dim)', paddingTop: idx === 4 ? 4 : undefined, borderTop: idx === 4 ? '1px solid var(--border)' : undefined }}>{label}</span>
                                      <span style={{ paddingTop: idx === 4 ? 4 : undefined, borderTop: idx === 4 ? '1px solid var(--border)' : undefined }}>{val}</span>
                                    </Fragment>
                                  ))}
                                </div>
                              </div>

                              {/* Order details */}
                              <div style={{ paddingLeft: 24, paddingRight: 24, borderLeft: '1px solid var(--border)' }}>
                                <div style={{ fontSize: 9, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Order</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 2 }}>
                                  {[
                                    ['Alpaca ID', <span style={{ fontFamily: 'monospace', fontSize: 10 }} title={o.alpaca_order_id}>{o.alpaca_order_id ? o.alpaca_order_id.slice(0,8) + '…' : '—'}</span>],
                                    ['Signal',    `#${o.signal_id ?? '—'}`],
                                    ['Placed',    fmtTs(o.created_at)],
                                    ['Filled',    fmtTs(o.filled_at)],
                                    ['Closed',    fmtTs(o.closed_at)],
                                  ].map(([label, val], idx) => (
                                    <Fragment key={idx}>
                                      <span style={{ color: 'var(--dim)' }}>{label}</span>
                                      <span>{val}</span>
                                    </Fragment>
                                  ))}
                                </div>
                              </div>

                              {/* Signal origin */}
                              <div style={{ paddingLeft: 24, borderLeft: '1px solid var(--border)' }}>
                                <div style={{ fontSize: 9, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Signal</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 2 }}>
                                  {(() => {
                                    const hasAi = (o.signal_source ?? '').split('+').some(s => s.trim() === 'ai')
                                    return [
                                      ['Conf',     <span style={{ fontWeight: 700 }}>{o.signal_confidence != null ? `${o.signal_confidence.toFixed(0)}%` : '—'}</span>],
                                      ['Mode',     <span style={{
                                        fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 3,
                                        background: hasAi ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--dim) 10%, transparent)',
                                        color: hasAi ? 'var(--accent)' : 'var(--dim)',
                                        border: `1px solid ${hasAi ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--dim) 20%, transparent)'}`,
                                      }}>{hasAi ? '🤖 LLM' : '📐 Rules'}</span>],
                                      ['Sources',  <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                        {(o.signal_source ?? '—').split('+').map((s, i) => <span key={i}>{s.trim()}</span>)}
                                      </span>],
                                      ['At',       fmtTs(o.signal_timestamp)],
                                    ].map(([label, val], idx) => (
                                      <Fragment key={idx}>
                                        <span style={{ color: 'var(--dim)' }}>{label}</span>
                                        <span>{val}</span>
                                      </Fragment>
                                    ))
                                  })()}
                                </div>
                              </div>

                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  )
}

const BT_COMPARATOR_COLORS = ['#58a6ff','#34d399','#fbbf24','#f87171','#a855f7','#22d3ee']

function BacktestPage({ wl, usage }) {
  // ── Form state ────────────────────────────────────────────────────────────
  const watchlistTickers = (wl?.watchlist ?? wl?.tickers ?? [])

  // Distinct tickers from active signals + past backtest runs — for quick-add
  const [signalTickers, setSignalTickers] = useState([])
  useEffect(() => {
    fetch(`${API}/signals?limit=500`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => {
        const fromSignals = (d.signals ?? []).map(s => s.ticker).filter(Boolean)
        setSignalTickers(prev => {
          const combined = [...new Set([...fromSignals, ...prev])].sort()
          return combined
        })
      })
      .catch(() => {})
  }, [])
  const [selTickers, setSelTickers] = useState([])
  const [addTickerInput, setAddTickerInput] = useState('')
  const [preset, setPreset] = useState('3M')
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0,10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0,10))
  const [confFloor, setConfFloor] = useState(75)
  const [maxHold, setMaxHold]       = useState(10)
  const [scanInterval, setScanInterval] = useState(1440)  // minutes; 1440 = end-of-day
  const [useLlm, setUseLlm]         = useState(false)
  const [isOos, setIsOos]           = useState(false)
  const [atrMult, setAtrMult]     = useState(2.0)
  const [rrRatio, setRrRatio]     = useState(2.0)
  const [rpm, setRpm]             = useState('')
  const [initBalance, setInitBalance] = useState(10000)
  const [posSizePct, setPosSizePct] = useState(10)  // % of balance per trade

  // ── Saved param profiles (DB-backed) ─────────────────────────────────────
  const [profiles, setProfiles] = useState([])
  const [profileNameInput, setProfileNameInput] = useState('')
  const [showProfileSave, setShowProfileSave] = useState(false)

  const _reloadProfiles = useCallback(() => {
    fetch(`${API}/backtest/profiles`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => setProfiles(d.profiles ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => { _reloadProfiles() }, [_reloadProfiles])

  const _saveProfile = async () => {
    const name = profileNameInput.trim()
    if (!name) return
    await fetch(`${API}/backtest/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        name,
        params: {
          tickers: selTickers,
          confFloor, maxHold, scanInterval, useLlm, isOos,
          atrMult, rrRatio, rpm, initBalance, posSizePct, cashoutR,
        },
      }),
    }).catch(() => {})
    setProfileNameInput('')
    setShowProfileSave(false)
    _reloadProfiles()
  }

  const _loadProfile = (p) => {
    const q = p.params
    if (q.tickers?.length) setSelTickers(q.tickers)
    if (q.confFloor != null) setConfFloor(q.confFloor)
    if (q.maxHold   != null) setMaxHold(q.maxHold)
    if (q.scanInterval != null) setScanInterval(q.scanInterval)
    if (q.useLlm   != null) setUseLlm(q.useLlm)
    if (q.isOos    != null) setIsOos(q.isOos)
    if (q.atrMult  != null) setAtrMult(q.atrMult)
    if (q.rrRatio  != null) setRrRatio(q.rrRatio)
    if (q.rpm      != null) setRpm(q.rpm)
    if (q.initBalance != null) setInitBalance(q.initBalance)
    if (q.posSizePct  != null) setPosSizePct(q.posSizePct)
    setCashoutR(q.cashoutR ?? null)
  }

  const _deleteProfile = async (id) => {
    await fetch(`${API}/backtest/profiles/${id}`, {
      method: 'DELETE', headers: getAuthHeaders(),
    }).catch(() => {})
    _reloadProfiles()
  }
  const [cashoutR, setCashoutR] = useState(null)     // null = disabled; number = R level

  // ── Run state ─────────────────────────────────────────────────────────────
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [notices, setNotices]   = useState([])   // fallback / quota_stop events
  const [report, setReport]     = useState(null) // current run result
  const [runError, setRunError] = useState(null)

  // ── Results floor slider (client-side re-filter) ──────────────────────────
  const [liveFloor, setLiveFloor] = useState(75)

  // ── Loaded past run persistence ───────────────────────────────────────────
  // Track which past run is currently open so the row stays highlighted and
  // the run is automatically reloaded after a page refresh.
  const [loadedRunId, setLoadedRunId] = useState(() => {
    try { return parseInt(localStorage.getItem('bt_loaded_run_id') || '', 10) || null }
    catch { return null }
  })
  const loadRun = useCallback((runId) => {
    fetch(`${API}/backtest/${runId}`, { headers: getAuthHeaders() })
      .then(res => res.json())
      .then(d => {
        setReport(d)
        setLiveFloor(d.confidence_floor ?? 75)
        setAiReview(null); setAiReviewError(null)
        setFloorSuggest(null); setFloorSuggestError(null)
        setLoadedRunId(runId)
        try { localStorage.setItem('bt_loaded_run_id', String(runId)) } catch {}
      })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // On mount, if a run was previously loaded restore it (once past runs are available).
  const _restoredRef = useRef(false)

  // ── Past runs ─────────────────────────────────────────────────────────────
  const { data: pastRunsData, reload: reloadRuns } = usePolling('/backtest', 30_000)
  const pastRuns = pastRunsData?.runs ?? []

  // Merge past-run tickers into signalTickers so users can quick-add tickers
  // they've previously backtested even when the signals table is empty.
  useEffect(() => {
    if (!pastRuns.length) return
    const fromRuns = pastRuns.flatMap(r => r.tickers ?? []).filter(Boolean)
    setSignalTickers(prev => [...new Set([...fromRuns, ...prev])].sort())
    // Restore the last-loaded run once the list is available.
    if (!_restoredRef.current && loadedRunId && !report) {
      const exists = pastRuns.some(r => r.id === loadedRunId)
      if (exists) { _restoredRef.current = true; loadRun(loadedRunId) }
    }
  }, [pastRuns.length])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Comparator ────────────────────────────────────────────────────────────
  const [compareSel, setCompareSel] = useState(new Set())
  const [compareData, setCompareData] = useState({})   // run_id -> run dict

  // Reset AI compare result whenever the selection changes.
  useEffect(() => { setAiCompare(null); setAiCompareError(null) }, [compareSel])

  // ── Pre-flight LLM notifier ───────────────────────────────────────────────
  const [quotaInfo, setQuotaInfo] = useState(null)
  useEffect(() => {
    if (!useLlm) return
    fetch(`${API}/provider/quota`, { headers: getAuthHeaders() }).then(r => r.json()).then(setQuotaInfo).catch(() => {})
  }, [useLlm])

  // ── Feature 2: model/provider change detection (no refresh needed) ────────
  const knownModelRef = useRef(null)
  const [modelBanner, setModelBanner] = useState(null)  // { from, to } when model changed
  useEffect(() => {
    const poll = async () => {
      try {
        const h = await fetch(`${API}/health`).then(r => r.json())
        const provider  = h?.llm_provider ?? null
        const modelName = h?.llm_model ?? h?.ollama_model ?? null
        if (!provider || !modelName) return
        const key = `${provider}::${modelName}`
        if (knownModelRef.current === null) { knownModelRef.current = key; return }
        if (knownModelRef.current !== key) {
          const prev = knownModelRef.current.replace('::', ' · ')
          const next = key.replace('::', ' · ')
          setModelBanner({ from: prev, to: next })
          knownModelRef.current = key
        }
      } catch {}
    }
    poll()
    const id = setInterval(poll, 20_000)
    return () => clearInterval(id)
  }, [])

  // ── Feature 3: tokens consumed during a run ───────────────────────────────
  const [runTokenDelta, setRunTokenDelta] = useState(null)

  // ── Feature 4: AI review of run results ──────────────────────────────────
  const [aiReview, setAiReview]               = useState(null)
  const [aiReviewLoading, setAiReviewLoading] = useState(false)
  const [aiReviewError, setAiReviewError]     = useState(null)

  // ── Feature 5: Experiment Advisor ────────────────────────────────────────
  const [floorSuggest,        setFloorSuggest]        = useState(null)
  const [floorSuggestLoading, setFloorSuggestLoading] = useState(false)
  const [floorSuggestError,   setFloorSuggestError]   = useState(null)

  // ── Feature 6: AI run comparator ─────────────────────────────────────────
  const [aiCompare,        setAiCompare]        = useState(null)
  const [aiCompareLoading, setAiCompareLoading] = useState(false)
  const [aiCompareError,   setAiCompareError]   = useState(null)

  const estDays = (() => {
    if (!startDate || !endDate) return 0
    const ms = new Date(endDate) - new Date(startDate)
    return Math.max(0, Math.round(ms / 86400000 * 5 / 7))
  })()
  // Scans per trading day depends on scan interval.
  // NYSE session = 390 min; ceil(390 / interval) + 1 to include both endpoints.
  const scansPerDay = scanInterval >= 1440 ? 1 : Math.ceil(390 / scanInterval) + 1
  const estRequests = selTickers.length * estDays * scansPerDay
  const avgTokens = (() => {
    // Prefer analysis_log history; fall back to backtest run averages when no live scans yet
    if (usage && (usage.total_rows ?? 0) > 0) {
      return Math.round(
        (usage.total_prompt_tokens + usage.total_completion_tokens) / Math.max(usage.total_rows, 1)
      )
    }
    const runs = pastRunsData?.runs ?? []
    const btCalls = runs.reduce((s, r) => s + (r.llm_calls ?? 0), 0)
    const btTokens = runs.reduce((s, r) => s + (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0), 0)
    if (btCalls > 0) return Math.round(btTokens / btCalls)
    return 0
  })()
  const estTokens   = estRequests * avgTokens
  const rpmCap      = parseInt(rpm) || null
  const estMinutes  = rpmCap ? Math.ceil(estRequests / rpmCap) : null
  const provLimits  = quotaInfo?.rate_limits ?? quotaInfo?.free_tier_limits?.[Object.keys(quotaInfo?.free_tier_limits ?? {})[0]] ?? null
  const overRpd     = provLimits?.rpd != null && estRequests > provLimits.rpd
  const overTpm     = provLimits?.tpm != null && rpmCap && (rpmCap * avgTokens) > provLimits.tpm

  // ── Ticker add / remove ────────────────────────────────────────────────────
  const addTicker = (t) => {
    const u = t.trim().toUpperCase()
    if (u && !selTickers.includes(u)) setSelTickers(s => [...s, u])
    setAddTickerInput('')
  }
  const removeTicker = (t) => setSelTickers(s => s.filter(x => x !== t))

  // ── Date preset ───────────────────────────────────────────────────────────
  const applyPreset = (p) => {
    setPreset(p.label)
    const end = new Date()
    const start = new Date(); start.setDate(start.getDate() - p.days)
    setStartDate(start.toISOString().slice(0,10))
    setEndDate(end.toISOString().slice(0,10))
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  const runBacktest = async () => {
    if (!selTickers.length) return
    setRunning(true); setProgress(0); setProgressLabel(''); setNotices([]); setReport(null); setRunError(null)
    setRunTokenDelta(null); setAiReview(null); setAiReviewError(null)
    setFloorSuggest(null); setFloorSuggestError(null)
    const body = {
      tickers: selTickers, start_date: startDate, end_date: endDate,
      initial_balance: parseFloat(initBalance) || 10000,
      position_size_pct: posSizePct / 100,
      cashout_r: cashoutR,
      confidence_floor: confFloor, max_hold_days: parseInt(maxHold) || 10,
      use_llm: useLlm, atr_multiple: parseFloat(atrMult) || 1.5,
      reward_risk: parseFloat(rrRatio) || 2.0,
      requests_per_minute: rpmCap,
      scan_interval_minutes: scanInterval,
      is_out_of_sample: isOos,
    }
    try {
      for await (const evt of readSSEStream(`${API}/backtest/stream`, body)) {
        if (evt.type === 'progress') {
          setProgress(evt.pct ?? 0)
          setProgressLabel(evt.ticker + (evt.day ? ' · ' + evt.day : ''))
        } else if (evt.type === 'fallback') {
          setNotices(n => [...n, { kind: 'fallback', msg: `Provider switched: ${evt.from} → ${evt.to} (${evt.reason ?? 'quota/error'})` }])
        } else if (evt.type === 'quota_stop') {
          setNotices(n => [...n, { kind: 'quota', msg: `Quota exhausted on ${evt.ticker} ${evt.day}: ${evt.msg}. Partial results saved.` }])
        } else if (evt.type === 'result') {
          setReport(evt.report)
          setLiveFloor(confFloor)
          reloadRuns()
          // Feature 3: token counts come directly from the report (accumulated in run_backtest)
          const pt  = evt.report?.llm_prompt_tokens ?? 0
          const ct  = evt.report?.llm_completion_tokens ?? 0
          const lc  = evt.report?.llm_calls ?? 0
          if (pt + ct > 0 || lc > 0) setRunTokenDelta({ calls: lc, prompt: pt, completion: ct, total: pt + ct })
        } else if (evt.type === 'error') {
          setRunError(evt.msg ?? 'Backtest failed.')
        }
      }
    } catch (e) {
      setRunError(e.message ?? 'Stream error.')
    } finally {
      setRunning(false); setProgress(100)
    }
  }

  // ── Live floor filtering ──────────────────────────────────────────────────
  const filteredTrades = report?.trades?.filter(t => (t.confidence ?? 0) >= liveFloor) ?? []

  // ── Dollar P&L helpers (requires wallet to be present) ───────────────────
  const walletPosSz = report?.metrics?.wallet?.position_size ?? 0
  const tradeDollarPnl = (t) => {
    if (!walletPosSz) return null
    const entry = t.entry || 1
    const stop = t.stop
    const riskFrac = stop != null && entry ? Math.abs(entry - stop) / entry : 0.02
    return walletPosSz * riskFrac * (t.r_multiple ?? 0)
  }
  // Per-ticker dollar P&L map: { AAPL: 312.5, MSFT: -45.2, ... }
  const perTickerDollarPnl = (() => {
    if (!walletPosSz) return {}
    const map = {}
    filteredTrades.forEach(t => {
      if (t.r_multiple == null || !t.exit_date) return  // only closed trades
      const pnl = tradeDollarPnl(t)
      if (pnl == null) return
      map[t.ticker] = (map[t.ticker] ?? 0) + pnl
    })
    return map
  })()

  const liveMetrics    = (() => {
    if (!report?.metrics?.floor_sweep) return report?.metrics ?? null
    const entry = report.metrics.floor_sweep.find(e => e.floor === Math.round(liveFloor / 5) * 5) ?? null
    // Full recompute happens server-side; for live slider, show counts from sweep + base metrics at initial floor
    return { ...(report.metrics), ...entry }
  })()
  const cumR = (() => {
    if (!report?.trades) return []
    const sorted = [...filteredTrades].sort((a,b) => (a.signal_date??'').localeCompare(b.signal_date??''))
    let sum = 0
    return sorted.map(t => { sum += t.r_multiple ?? 0; return { date: t.signal_date?.slice(5), r: +sum.toFixed(3) } })
  })()

  // ── Comparator ────────────────────────────────────────────────────────────
  const toggleCompare = async (runId) => {
    const next = new Set(compareSel)
    if (next.has(runId)) { next.delete(runId) }
    else {
      next.add(runId)
      if (!compareData[runId]) {
        const data = await fetch(`${API}/backtest/${runId}`, { headers: getAuthHeaders() }).then(r => r.json()).catch(() => null)
        if (data) setCompareData(prev => ({...prev, [runId]: data}))
      }
    }
    setCompareSel(next)
  }

  const compareRuns = [...compareSel].map(id => compareData[id]).filter(Boolean)

  const compareChartData = (() => {
    if (!compareRuns.length) return []
    const maxLen = Math.max(...compareRuns.map(r => (r.trades?.length ?? 0)))
    return Array.from({ length: maxLen }, (_, i) => {
      const pt = { i }
      compareRuns.forEach((r, ri) => {
        const trades = [...(r.trades ?? [])].sort((a,b) => (a.signal_date??'').localeCompare(b.signal_date??''))
        let sum = 0
        for (let j = 0; j <= i && j < trades.length; j++) sum += trades[j].r_multiple ?? 0
        pt[`run_${r.id}`] = i < trades.length ? +sum.toFixed(3) : undefined
      })
      return pt
    })
  })()

  // $ equity curve chart data — merge dollar_equity_curve arrays across runs on date union
  const compareDollarChartData = (() => {
    const runsWithWallet = compareRuns.filter(r => r.metrics?.wallet?.dollar_equity_curve?.length)
    if (runsWithWallet.length < 1) return []
    // Collect all dates across runs
    const dateSet = new Set()
    runsWithWallet.forEach(r => r.metrics.wallet.dollar_equity_curve.forEach(p => { if (p.date) dateSet.add(p.date) }))
    const dates = [...dateSet].sort()
    return dates.map(date => {
      const pt = { date: date.slice(5) }
      runsWithWallet.forEach(r => {
        const pts = r.metrics.wallet.dollar_equity_curve
        // Forward-fill: last known equity up to this date
        let val = null
        for (const p of pts) { if (p.date <= date && p.equity != null) val = p.equity }
        if (val != null) pt[`run_${r.id}`] = val
      })
      return pt
    })
  })()

  const deleteRun = async (runId) => {
    await fetch(`${API}/backtest/${runId}`, { method: 'DELETE', headers: getAuthHeaders() })
    reloadRuns()
    setCompareSel(s => { const n = new Set(s); n.delete(runId); return n })
  }

  // Feature 4: request an AI verdict on the currently loaded report
  // Fresh runs have report.run_id (from backtest.py); past runs loaded via GET /backtest/{id}
  // have report.id (DB column name). Accept either.
  const reportRunId = report?.run_id ?? report?.id ?? null
  const runAiReview = async () => {
    if (!reportRunId) return
    setAiReviewLoading(true); setAiReview(null); setAiReviewError(null)
    try {
      const res = await fetch(`${API}/backtest/${reportRunId}/review`, { method: 'POST', headers: getAuthHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setAiReview(await res.json())
    } catch (e) {
      setAiReviewError(e.message ?? 'Review failed.')
    } finally {
      setAiReviewLoading(false)
    }
  }

  const runFloorSuggest = async () => {
    if (!reportRunId) return
    setFloorSuggestLoading(true); setFloorSuggestError(null)
    try {
      const res = await fetch(`${API}/backtest/${reportRunId}/experiment-advisor`, { method: 'POST', headers: getAuthHeaders() })
      if (!res.ok) throw new Error(await res.text())
      setFloorSuggest(await res.json())
    } catch (e) { setFloorSuggestError(e.message) }
    finally { setFloorSuggestLoading(false) }
  }

  const runAiCompare = async () => {
    if (compareSel.size < 2) return
    setAiCompareLoading(true); setAiCompareError(null)
    try {
      const res = await fetch(`${API}/backtest/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ run_ids: [...compareSel] }),
      })
      if (!res.ok) throw new Error(await res.text())
      setAiCompare(await res.json())
    } catch (e) { setAiCompareError(e.message) }
    finally { setAiCompareLoading(false) }
  }

  const cloneRunParams = (run, flipLlm = false) => {
    setSelTickers(run.tickers ?? [])
    setStartDate(run.start_date ?? '')
    setEndDate(run.end_date ?? '')
    setConfFloor(run.confidence_floor ?? 75)
    setMaxHold(run.max_hold_days ?? 10)
    setUseLlm(flipLlm ? run.signal_mode !== 'llm' : run.signal_mode === 'llm')
    setIsOos(run.is_out_of_sample ?? false)
    setAtrMult(run.atr_multiple ?? 2.0)
    setRrRatio(run.reward_risk ?? 2.0)
    setRpm(run.requests_per_minute ?? '')
    setScanInterval(run.scan_interval_minutes ?? 1440)
    // Restore position size from stored wallet metrics if available
    const storedPos = run.metrics?.wallet?.position_size_pct
    if (storedPos != null) setPosSizePct(Math.round(storedPos * 100))
    // Restore cashout_r from stored metrics (it lives at top-level of metrics or wallet)
    setCashoutR(run.metrics?.cashout_r ?? null)
    document.querySelector('.bt-params-section')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="explorer-page">

      {/* ── Model-change banner (Feature 2) ──────────────────────────────────── */}
      {modelBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
          background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)',
          borderRadius: 8, fontSize: 13, marginBottom: 12,
        }}>
          <span>🔄 LLM model changed: <strong>{modelBanner.from}</strong> → <strong>{modelBanner.to}</strong></span>
          <button className="btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                  onClick={() => setModelBanner(null)}>Dismiss</button>
        </div>
      )}

      {/* ── Token usage summary (Feature 1) ──────────────────────────────────── */}
      {/* Computed from backtest run records, not analysis_log, so every LLM     */}
      {/* backtest call is reflected here even if no live signal scans were done. */}
      {(() => {
        const runs = pastRunsData?.runs ?? []
        const todayIso = new Date().toISOString().slice(0, 10)
        const btTotalPt  = runs.reduce((s, r) => s + (r.llm_prompt_tokens     ?? 0), 0)
        const btTotalCt  = runs.reduce((s, r) => s + (r.llm_completion_tokens ?? 0), 0)
        const btTotalCalls = runs.reduce((s, r) => s + (r.llm_calls           ?? 0), 0)
        const btTodayTokens = runs
          .filter(r => (r.created_at ?? '').slice(0, 10) === todayIso)
          .reduce((s, r) => s + (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0), 0)
        return (
          <div className="usage-summary-row" style={{ marginBottom: 16 }}>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Today</span>
              <span className="usage-stat-value">{btTodayTokens.toLocaleString()}</span>
              <span className="usage-stat-sub">backtest tokens today</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Total tokens</span>
              <span className="usage-stat-value">{(btTotalPt + btTotalCt).toLocaleString()}</span>
              <span className="usage-stat-sub">all backtest runs</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Prompt</span>
              <span className="usage-stat-value">{btTotalPt.toLocaleString()}</span>
              <span className="usage-stat-sub">input tokens</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Completion</span>
              <span className="usage-stat-value">{btTotalCt.toLocaleString()}</span>
              <span className="usage-stat-sub">output tokens</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">LLM calls</span>
              <span className="usage-stat-value">{btTotalCalls.toLocaleString()}</span>
              <span className="usage-stat-sub">across {runs.filter(r => r.llm_calls > 0).length} run{runs.filter(r => r.llm_calls > 0).length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        )
      })()}

      {/* ── Section 1: Parameters ──────────────────────────────────────────── */}
      <div className="explorer-section bt-params-section">
        <div className="section-header">
          <span className="section-badge">1</span>
          <span className="section-label">Parameters</span>
          <span className="section-desc">Configure and run a backtest</span>
        </div>

        {/* Ticker multiselect */}
        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label className="settings-label">Tickers</label>
          <div className="chip-list">
            {selTickers.map(t => (
              <span key={t} className="chip">
                {t}
                <button className="chip-remove" onClick={() => removeTicker(t)}>×</button>
              </span>
            ))}
          </div>
          <div className="add-ticker-row" style={{ marginTop: 6 }}>
            <input
              className="ticker-input"
              placeholder="Add ticker…"
              value={addTickerInput}
              onChange={e => setAddTickerInput(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter') addTicker(addTickerInput) }}
            />
            <button className="btn-primary btn-sm" onClick={() => addTicker(addTickerInput)}>Add</button>
          </div>
          {/* Quick-add rows: Dashboard watchlist + signal/backtest history */}
          {watchlistTickers.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--dim)' }}>
              <span style={{ marginRight: 4, fontWeight: 500 }}>Dashboard:</span>
              {watchlistTickers.map(t => (
                <button key={t} className="btn-ghost btn-sm" style={{ marginRight: 4 }}
                        onClick={() => addTicker(t)} disabled={selTickers.includes(t)}
                        title={`Add ${t} from watchlist`}>{t}</button>
              ))}
              <button className="btn-ghost btn-sm"
                      style={{ marginLeft: 4, opacity: 0.6 }}
                      title="Add all watchlist tickers"
                      onClick={() => watchlistTickers.forEach(t => addTicker(t))}>
                + all
              </button>
            </div>
          )}
          {signalTickers.filter(t => !watchlistTickers.includes(t)).length > 0 && (
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dim)' }}>
              <span style={{ marginRight: 4, fontWeight: 500 }}>From past runs / signals:</span>
              {signalTickers.filter(t => !watchlistTickers.includes(t)).map(t => (
                <button key={t} className="btn-ghost btn-sm" style={{ marginRight: 4 }}
                        onClick={() => addTicker(t)} disabled={selTickers.includes(t)}
                        title={`Add ${t} (from signals or past backtest)`}>{t}</button>
              ))}
            </div>
          )}
        </div>

        {/* Time period */}
        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label className="settings-label">Time period</label>
          <div className="filter-group" style={{ marginBottom: 8 }}>
            {BT_PRESETS.map(p => (
              <button key={p.label}
                className={`filter-btn ${preset === p.label ? 'active' : ''}`}
                onClick={() => applyPreset(p)}>{p.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <label className="settings-label" style={{ fontSize: 11 }}>From</label>
              <input type="date" className="settings-select" value={startDate}
                     onChange={e => { setStartDate(e.target.value); setPreset('') }} />
            </div>
            <div>
              <label className="settings-label" style={{ fontSize: 11 }}>To</label>
              <input type="date" className="settings-select" value={endDate}
                     onChange={e => { setEndDate(e.target.value); setPreset('') }} />
            </div>
          </div>
          {startDate && new Date(startDate) < new Date(new Date().setFullYear(new Date().getFullYear() - 2)) && (
            <p style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 6 }}>
              ⚠ Window exceeds ~2 years — 1H/4H indicators unavailable; only daily-bar rules will fire.
            </p>
          )}
        </div>

        {/* Params — three labeled groups */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 12 }}>

          {/* ── Group 1: Signal Filtering ── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                          letterSpacing: '0.09em', marginBottom: 8 }}>
              Signal Filtering
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="settings-field" style={{ minWidth: 200 }}>
                <label className="settings-label"
                       title="Minimum AI confidence (0–100%) for a signal to be included in the backtest. Higher = fewer but stronger signals.">
                  Confidence floor: <strong>{confFloor}%</strong>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <input type="range" min={0} max={100} step={5} value={confFloor}
                         onChange={e => setConfFloor(Number(e.target.value))} className="filter-range"
                         style={{ flex: 1 }} />
                  <span className="filter-val">{confFloor}%</span>
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-label"
                       title="How often to scan for signals within each trading day. EOD = once per day at close (fastest). Finer intervals increase LLM call count proportionally.">
                  Scan interval
                </label>
                <div className="filter-group" style={{ marginTop: 4 }}>
                  {[
                    { label: 'EOD', val: 1440, tip: 'Once per day at market close' },
                    { label: '4h',  val: 240,  tip: '~2 scans/day' },
                    { label: '1h',  val: 60,   tip: '~7 scans/day' },
                    { label: '30m', val: 30,   tip: '~14 scans/day' },
                    { label: '15m', val: 15,   tip: '~27 scans/day' },
                  ].map(({ label, val, tip }) => (
                    <button key={val}
                            className={`filter-btn ${scanInterval === val ? 'active' : ''}`}
                            title={tip}
                            onClick={() => setScanInterval(val)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', marginBottom: 14, opacity: 0.4 }} />

          {/* ── Group 2: Trade Setup ── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                          letterSpacing: '0.09em', marginBottom: 8 }}>
              Trade Setup
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="settings-field">
                <label className="settings-label"
                       title="Stop distance = ATR × this multiple. Larger = wider stop, fewer premature exits but bigger losses when wrong.">
                  ATR multiple
                </label>
                <input type="number" min={0.1} step={0.1} value={atrMult}
                       onChange={e => setAtrMult(e.target.value)} className="settings-num-input"
                       style={{ marginTop: 4 }} />
              </div>
              <div className="settings-field">
                <label className="settings-label"
                       title="Target distance = stop distance × this ratio. E.g. 2.0 means you aim to win twice what you risk.">
                  Reward : Risk
                </label>
                <input type="number" min={0.1} step={0.1} value={rrRatio}
                       onChange={e => setRrRatio(e.target.value)} className="settings-num-input"
                       style={{ marginTop: 4 }} />
              </div>
              <div className="settings-field">
                <label className="settings-label"
                       title="If neither stop nor target is hit after this many days, the trade closes at the current price.">
                  Max hold days
                </label>
                <input type="number" min={1} max={120} value={maxHold}
                       onChange={e => setMaxHold(e.target.value)} className="settings-num-input"
                       style={{ marginTop: 4 }} />
              </div>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', marginBottom: 14, opacity: 0.4 }} />

          {/* ── Group 3: Virtual Wallet ── */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                          letterSpacing: '0.09em', marginBottom: 8 }}>
              Virtual Wallet
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="settings-field">
                <label className="settings-label"
                       title="Starting balance for the virtual wallet simulation">
                  Initial balance ($)
                </label>
                <input type="number" min={100} step={100} value={initBalance}
                       onChange={e => setInitBalance(e.target.value)} className="settings-num-input"
                       style={{ width: 100, marginTop: 4 }} />
              </div>
              <div className="settings-field" style={{ minWidth: 200 }}>
                <label className="settings-label"
                       title="Fraction of initial balance invested per signal (fixed-fractional sizing). E.g. 10% of $10,000 = $1,000 per trade.">
                  Position size: <strong>{posSizePct}%</strong>
                  <span style={{ marginLeft: 6, color: 'var(--dim)', fontSize: 11 }}>
                    = ${Math.round((parseFloat(initBalance) || 10000) * posSizePct / 100).toLocaleString()}/trade
                  </span>
                </label>
                <input type="range" min={1} max={25} step={1} value={posSizePct}
                       onChange={e => setPosSizePct(Number(e.target.value))}
                       className="filter-range" style={{ width: '100%', marginTop: 4 }} />
              </div>
              <div className="settings-field" style={{ minWidth: 210 }}>
                <label className="settings-label"
                       title="Cashout rule: exit a trade early when its unrealised R reaches this level, locking in profit before a reversal. Slide to 0 or press 'off' to disable.">
                  Cashout at R:{' '}
                  <strong style={{ color: cashoutR != null ? 'var(--yellow)' : undefined }}>
                    {cashoutR != null ? cashoutR + 'R' : 'off'}
                  </strong>
                  {cashoutR != null && rrRatio > 0 && (
                    <span style={{ marginLeft: 6, color: 'var(--dim)', fontSize: 11 }}>
                      (target is {Number(rrRatio).toFixed(1)}R)
                    </span>
                  )}
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <input type="range" min={0} max={20} step={1}
                         value={cashoutR != null ? Math.round(cashoutR * 4) : 0}
                         onChange={e => {
                           const v = Number(e.target.value)
                           setCashoutR(v === 0 ? null : +(v / 4).toFixed(2))
                         }}
                         className="filter-range" style={{ flex: 1 }} />
                  {cashoutR != null && (
                    <button onClick={() => setCashoutR(null)}
                            style={{ fontSize: 10, padding: '1px 6px', background: 'var(--surface-2)',
                                     border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                                     color: 'var(--dim)' }}>off</button>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* LLM toggle + RPM + OOS */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
          <div className="settings-field">
            <label className="settings-label">LLM mode</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className={`settings-toggle ${useLlm ? 'on' : 'off'}`} onClick={() => setUseLlm(v => !v)}>
                <span className="settings-toggle-knob" />
              </button>
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>{useLlm ? 'AI analysis on each day' : 'Rules only (faster)'}</span>
            </div>
          </div>
          {useLlm && (
            <div className="settings-field">
              <label className="settings-label">Requests/min cap</label>
              <input type="number" min={1} value={rpm} placeholder="no cap"
                     onChange={e => setRpm(e.target.value)} className="settings-num-input" />
            </div>
          )}
          <div className="settings-field">
            <label className="settings-label"
                   title="Mark this window as a held-out test set — AI Review will note it as out-of-sample evidence">
              Out-of-sample
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className={`settings-toggle ${isOos ? 'on' : 'off'}`} onClick={() => setIsOos(v => !v)}>
                <span className="settings-toggle-knob" />
              </button>
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>{isOos ? 'OOS holdout' : 'In-sample / training'}</span>
            </div>
          </div>
        </div>

        {/* ── Saved configurations ──────────────────────────────────────────── */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Existing profile chips */}
            {profiles.map(p => (
              <span key={p.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                color: 'var(--text)',
              }}
                title={`Created ${p.createdAt} · ${(p.params.tickers??[]).join(', ')} · Floor ${p.params.confFloor}% · ATR ${p.params.atrMult}× · R:R ${p.params.rrRatio}:1 · Hold ${p.params.maxHold}d`}
                onClick={() => _loadProfile(p)}>
                📋 {p.name}
                <button onClick={e => { e.stopPropagation(); _deleteProfile(p.id) }}
                        style={{ background:'none', border:'none', cursor:'pointer',
                                 color:'var(--dim)', fontSize:12, padding:'0 0 0 2px', lineHeight:1 }}
                        title="Delete this profile">×</button>
              </span>
            ))}

            {/* Save current params */}
            {showProfileSave ? (
              <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                <input autoFocus value={profileNameInput} onChange={e => setProfileNameInput(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter') _saveProfile(); if (e.key === 'Escape') setShowProfileSave(false) }}
                       placeholder="Profile name…"
                       style={{ fontSize:12, padding:'3px 8px', borderRadius:6,
                                background:'var(--surface-1)', border:'1px solid var(--accent)',
                                color:'var(--text)', outline:'none', width:140 }} />
                <button className="btn-primary btn-sm" onClick={_saveProfile}
                        disabled={!profileNameInput.trim()}>Save</button>
                <button className="btn-sm" onClick={() => setShowProfileSave(false)}
                        style={{ background:'var(--surface-2)', border:'1px solid var(--border)', color:'var(--dim)', borderRadius:6, padding:'3px 10px', cursor:'pointer', fontSize:12 }}>
                  Cancel
                </button>
              </span>
            ) : (
              <button onClick={() => setShowProfileSave(true)}
                      style={{ background:'none', border:'1px dashed var(--border)', color:'var(--dim)',
                               borderRadius:20, padding:'3px 12px', fontSize:12, cursor:'pointer' }}
                      title="Save current parameters as a named profile">
                + Save as profile
              </button>
            )}
          </div>
        </div>

        <button className="btn-primary" onClick={runBacktest}
                disabled={running || !selTickers.length}>
          {running ? 'Running…' : '▶ Run Backtest'}
        </button>
        {runError && <p style={{ color: 'var(--red)', marginTop: 8, fontSize: 13 }}>✗ {runError}</p>}
      </div>

      {/* ── Section 2: LLM pre-flight notifier (LLM mode only) ─────────────── */}
      {useLlm && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">2</span>
            <span className="section-label">LLM Quota Estimate</span>
            <span className="section-desc">Approximate cost before running</span>
          </div>
          <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Est. requests</span>
              <span className="usage-stat-value">{estRequests.toLocaleString()}</span>
              <span className="usage-stat-sub">
                {selTickers.length} ticker × ~{estDays} days × {scansPerDay} scan{scansPerDay !== 1 ? 's' : ''}/day
              </span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Est. tokens</span>
              <span className="usage-stat-value">{avgTokens ? (estTokens/1000).toFixed(1)+'k' : '—'}</span>
              <span className="usage-stat-sub">{avgTokens ? `~${avgTokens} tok/call avg` : 'no usage history'}</span>
            </div>
            {rpmCap && (
              <div className="usage-stat-card">
                <span className="usage-stat-label">Est. duration</span>
                <span className="usage-stat-value">{estMinutes}m</span>
                <span className="usage-stat-sub">at {rpmCap} req/min</span>
              </div>
            )}
            {provLimits?.rpd && (
              <div className={`usage-stat-card ${overRpd ? 'usage-stat-card-warn' : ''}`}>
                <span className="usage-stat-label">Daily limit (RPD)</span>
                <span className="usage-stat-value" style={{ color: overRpd ? 'var(--red)' : undefined }}>
                  {provLimits.rpd.toLocaleString()}
                </span>
                <span className="usage-stat-sub">{overRpd ? '⚠ may exceed limit' : 'within limit'}</span>
              </div>
            )}
            {provLimits?.tpm && rpmCap && (
              <div className={`usage-stat-card ${overTpm ? 'usage-stat-card-warn' : ''}`}>
                <span className="usage-stat-label">TPM limit</span>
                <span className="usage-stat-value" style={{ color: overTpm ? 'var(--red)' : undefined }}>
                  {(provLimits.tpm/1000).toFixed(0)}k
                </span>
                <span className="usage-stat-sub">{overTpm ? '⚠ may throttle' : 'within limit'}</span>
              </div>
            )}
          </div>
          {(overRpd || overTpm) && (
            <p style={{ color: 'var(--yellow)', fontSize: 12, marginTop: 8 }}>
              ⚠ Estimated usage exceeds provider limits. Reduce tickers/window or lower RPM cap to stay within quota. Auto-fallback will engage if configured.
            </p>
          )}
        </div>
      )}

      {/* ── Section 3: Progress ────────────────────────────────────────────── */}
      {(running || progress > 0) && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">3</span>
            <span className="section-label">Progress</span>
          </div>
          <div className="stepper">
            <div className="stepper-bar-track">
              <div className="stepper-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 6 }}>
              {progressLabel || (running ? 'Starting…' : 'Complete')} — {progress}%
            </div>
          </div>
          {notices.map((n, i) => (
            <div key={i} style={{
              marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12,
              background: n.kind === 'quota' ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)',
              color: n.kind === 'quota' ? 'var(--red)' : 'var(--yellow)',
            }}>
              {n.kind === 'fallback' ? '🔄' : '⚠'} {n.msg}
            </div>
          ))}
          {/* Token usage shown in Section 4 Metrics once report loads */}
        </div>
      )}

      {/* ── Sections 4–8: Results (once a report is loaded) ────────────────── */}
      {report && (
        <>
          {/* ── Missing-metrics warning (orphaned run) ───────────────────── */}
          {!report.metrics && (
            <div style={{
              margin: '0 0 16px', padding: '10px 14px', borderRadius: 8,
              background: 'rgba(251,191,36,0.10)', border: '1px solid var(--yellow)',
              display: 'flex', gap: 10, alignItems: 'flex-start',
            }}>
              <span style={{ fontSize: 16 }}>⚠</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--yellow)', marginBottom: 3 }}>
                  No metrics for this run
                </div>
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>
                  This run was saved without metrics — it may have been interrupted or created by an older
                  version. Re-run the backtest with the same parameters to generate full results.
                </div>
              </div>
            </div>
          )}

          {/* ── Section 4: Metric tiles ──────────────────────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">4</span>
              <span className="section-label">Metrics</span>
              <span className="section-desc">
                {(() => {
                  const si = report.scan_interval_minutes ?? 1440
                  const siLbl = si >= 1440 ? 'EOD' : si >= 60 ? `${si / 60}h` : `${si}m`
                  const cashoutPart = report.metrics?.cashout_r != null ? ` · Cashout ${report.metrics.cashout_r}R` : ''
                  return `Scan ${siLbl} · Floor ${report.confidence_floor ?? '?'}% · ATR ${report.atr_multiple ?? '?'}× · R:R ${report.reward_risk ?? '?'}:1 · Hold ${report.max_hold_days ?? '?'}d${cashoutPart}`
                })()}
              </span>
            </div>
            <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Win rate</span>
                <span className="usage-stat-value">{fmtPct(liveMetrics?.win_rate)}</span>
                <span className="usage-stat-sub">{liveMetrics?.total_trades ?? 0} trades</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Avg R-multiple</span>
                <span className="usage-stat-value"
                      style={{ color: (liveMetrics?.avg_r_multiple ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {fmtR(liveMetrics?.avg_r_multiple)}
                </span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Sharpe ratio</span>
                <span className="usage-stat-value">{liveMetrics?.sharpe != null ? liveMetrics.sharpe.toFixed(2) : '—'}</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Max drawdown</span>
                <span className="usage-stat-value" style={{ color: 'var(--red)' }}>
                  {liveMetrics?.max_drawdown != null ? liveMetrics.max_drawdown.toFixed(2) + 'R' : '—'}
                </span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">False-positive rate</span>
                <span className="usage-stat-value">{fmtPct(liveMetrics?.false_positive_rate)}</span>
              </div>
              {(liveMetrics?.cashout_count ?? 0) > 0 && (
                <div className="usage-stat-card" title="Trades exited early by the cashout rule">
                  <span className="usage-stat-label">💰 Cashouts</span>
                  <span className="usage-stat-value" style={{ color: 'var(--yellow)' }}>
                    {liveMetrics.cashout_count}
                  </span>
                  <span className="usage-stat-sub">
                    of {liveMetrics.total_trades} trades · {report.metrics?.cashout_r}R rule
                  </span>
                </div>
              )}
            </div>
            {/* LLM usage row — always shown; shows 0 for rule-mode runs */}
            <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
              <div className="usage-stat-card">
                <span className="usage-stat-label">LLM calls</span>
                <span className="usage-stat-value">{(report?.llm_calls ?? 0).toLocaleString()}</span>
                <span className="usage-stat-sub">{(report?.llm_calls ?? 0) === 0 ? 'rule mode' : 'analyze() calls'}</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Run tokens</span>
                <span className="usage-stat-value">
                  {((report?.llm_prompt_tokens ?? 0) + (report?.llm_completion_tokens ?? 0)).toLocaleString()}
                </span>
                <span className="usage-stat-sub">prompt + completion</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Prompt tokens</span>
                <span className="usage-stat-value">{(report?.llm_prompt_tokens ?? 0).toLocaleString()}</span>
                <span className="usage-stat-sub">input</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Completion tokens</span>
                <span className="usage-stat-value">{(report?.llm_completion_tokens ?? 0).toLocaleString()}</span>
                <span className="usage-stat-sub">output</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Model</span>
                {/* value = provider name; sub = full model string */}
                <span className="usage-stat-value" style={{ fontSize: 13 }}
                      title={report?.llm_provider
                        ? `${report.llm_provider} · ${report.llm_model ?? 'model unknown'}`
                        : 'rule-based (no LLM)'}>
                  {report?.llm_provider ?? 'rule-based'}
                </span>
                <span className="usage-stat-sub" style={{ wordBreak: 'break-all' }}>
                  {report?.llm_model ?? (report?.llm_provider ? 'model unknown' : 'no LLM')}
                </span>
              </div>
            </div>
            {report?.warnings?.length > 0 && (
              <ul style={{ fontSize: 12, color: 'var(--yellow)', margin: '8px 0 0 0', paddingLeft: 18 }}>
                {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}

            {/* ── Virtual wallet summary tiles ── */}
            {report.metrics?.wallet && (() => {
              const w = report.metrics.wallet
              const bh = w.buy_and_hold
              const ret = w.total_return_pct ?? 0
              const bhRet = bh?.return_pct ?? null
              const alpha = (bhRet != null) ? round2(ret - bhRet) : null
              const fmtDollar = v => v != null
                ? `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                : '—'
              const fmtRetPct = v => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'
              function round2(v) { return Math.round(v * 100) / 100 }
              return (
                <div style={{ marginTop: 12 }}>
                  <div className="chart-title" style={{ marginBottom: 8 }}>
                    💰 Virtual wallet
                    <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 8, fontWeight: 400 }}>
                      {fmtDollar(w.initial_balance)} starting · {fmtDollar(w.position_size)}/trade ({Math.round((w.position_size_pct ?? 0.1) * 100)}%)
                    </span>
                  </div>
                  <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12 }}>
                    <div className="usage-stat-card">
                      <span className="usage-stat-label">Final portfolio</span>
                      <span className="usage-stat-value"
                            style={{ color: (w.total_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {fmtDollar(w.final_equity)}
                      </span>
                      <span className="usage-stat-sub"
                            style={{ color: (w.total_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {(w.total_pnl ?? 0) >= 0 ? '+' : ''}{fmtDollar(w.total_pnl)} P&L
                      </span>
                    </div>
                    <div className="usage-stat-card">
                      <span className="usage-stat-label">Strategy return</span>
                      <span className="usage-stat-value"
                            style={{ color: ret >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {fmtRetPct(ret)}
                      </span>
                      <span className="usage-stat-sub">on {fmtDollar(w.initial_balance)}</span>
                    </div>
                    {bhRet != null && (
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Buy &amp; hold</span>
                        <span className="usage-stat-value"
                              style={{ color: bhRet >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {fmtRetPct(bhRet)}
                        </span>
                        <span className="usage-stat-sub">equal-weight benchmark</span>
                      </div>
                    )}
                    {alpha != null && (
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Alpha vs B&amp;H</span>
                        <span className="usage-stat-value"
                              style={{ color: alpha >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {fmtRetPct(alpha)}
                        </span>
                        <span className="usage-stat-sub">{alpha >= 0 ? 'outperformed' : 'underperformed'}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* ── Section 5: Floor tuning ──────────────────────────────────── */}
          {report?.metrics?.floor_sweep?.length > 0 && (
            <div className="explorer-section">
              <div className="section-header">
                <span className="section-badge">5</span>
                <span className="section-label">Confidence-floor tuning</span>
                <span className="section-desc">Drag to re-filter results — no re-run needed</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <input type="range" min={0} max={100} step={5} value={liveFloor}
                       onChange={e => setLiveFloor(Number(e.target.value))} className="filter-range"
                       style={{ flex: 1 }} />
                <span className="filter-val" style={{ minWidth: 40 }}>{liveFloor}%</span>
              </div>
              <div className="chart-title" style={{ marginBottom: 6 }}>Win rate / Avg R / Trade count vs. floor</div>
              <ResponsiveContainer width="100%" height={130}>
                <AreaChart data={report.metrics.floor_sweep}
                           margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                  <XAxis dataKey="floor" tick={AXIS_TICK} axisLine={false} tickLine={false}
                         tickFormatter={v => v + '%'} />
                  <YAxis yAxisId="rate" domain={[0,1]} tick={AXIS_TICK} axisLine={false}
                         tickLine={false} width={30} tickFormatter={v => Math.round(v*100)+'%'} />
                  <YAxis yAxisId="count" orientation="right" tick={AXIS_TICK} axisLine={false}
                         tickLine={false} width={28} />
                  <Tooltip {...CHART_TOOLTIP_STYLE}
                    formatter={(v, name) => {
                      if (name === 'win_rate') return [fmtPct(v), 'Win rate']
                      if (name === 'avg_r_multiple') return [fmtR(v), 'Avg R']
                      return [v, 'Trades']
                    }}
                  />
                  <ReferenceLine yAxisId="rate" x={liveFloor} stroke="var(--accent)" strokeDasharray="4 2" />
                  <Area yAxisId="rate" type="monotone" dataKey="win_rate"
                        stroke="#3fb950" fill="rgba(63,185,80,0.15)" strokeWidth={1.5} dot={false} />
                  <Area yAxisId="rate" type="monotone" dataKey="avg_r_multiple"
                        stroke="#58a6ff" fill="rgba(88,166,255,0.1)" strokeWidth={1.5} dot={false} />
                  <Area yAxisId="count" type="monotone" dataKey="total_trades"
                        stroke="#8b949e" fill="none" strokeWidth={1} dot={false} strokeDasharray="3 2" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Section 6: Cumulative R-multiple curve ───────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">6</span>
              <span className="section-label">Cumulative R-multiple curve</span>
              <span className="section-desc">Running sum of risk-normalised P&L (floor: {liveFloor}%)</span>
            </div>
            {cumR.length > 1 ? (
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={cumR} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cumRGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#58a6ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                  <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false}
                         interval={Math.max(1, Math.floor(cumR.length / 6))} />
                  <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                         width={38} tickFormatter={v => v.toFixed(1) + 'R'} />
                  <Tooltip {...CHART_TOOLTIP_STYLE}
                    formatter={v => [fmtR(v), 'Cumulative R']} />
                  <ReferenceLine y={0} stroke="#8b949e" strokeDasharray="3 2" />
                  <Area type="monotone" dataKey="r" stroke="#58a6ff" strokeWidth={1.5}
                        fill="url(#cumRGrad)" dot={false} activeDot={{ r: 3, fill: '#58a6ff' }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="chart-empty">No trades at this confidence floor.</p>
            )}
          </div>

          {/* ── Section 6b: $ Portfolio equity curve ─────────────────────── */}
          {report.metrics?.wallet?.dollar_equity_curve?.length > 1 && (() => {
            const w = report.metrics.wallet
            // Merge strategy curve and BH curve on a unified date set
            const stratMap = Object.fromEntries(
              (w.dollar_equity_curve ?? []).map(p => [p.date, p.equity])
            )
            const bhMap = Object.fromEntries(
              (w.buy_and_hold?.daily_equity_curve ?? []).map(p => [p.date, p.equity])
            )
            const allDates = [...new Set([
              ...(w.dollar_equity_curve ?? []).map(p => p.date),
              ...(w.buy_and_hold?.daily_equity_curve ?? []).map(p => p.date),
            ])].filter(Boolean).sort()
            // Forward-fill
            let lastStr = w.initial_balance, lastBh = w.initial_balance
            const merged = allDates.map(date => {
              if (stratMap[date] != null) lastStr = stratMap[date]
              if (bhMap[date]   != null) lastBh  = bhMap[date]
              return { date, strategy: lastStr, buy_and_hold: bhMap[date] != null ? lastBh : undefined }
            })
            const hasBh = w.buy_and_hold?.daily_equity_curve?.length > 0
            const fmtUSD = v => `$${Math.round(v).toLocaleString()}`
            return (
              <div className="explorer-section">
                <div className="section-header">
                  <span className="section-badge">6b</span>
                  <span className="section-label">$ Portfolio equity curve</span>
                  <span className="section-desc">Virtual wallet value over the backtest window</span>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={merged} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="stratGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#58a6ff" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
                      </linearGradient>
                      {hasBh && (
                        <linearGradient id="bhGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#f0883e" stopOpacity={0.15} />
                          <stop offset="95%" stopColor="#f0883e" stopOpacity={0} />
                        </linearGradient>
                      )}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                    <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false}
                           interval={Math.max(1, Math.floor(merged.length / 6))} />
                    <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                           width={58} tickFormatter={fmtUSD} />
                    <Tooltip {...CHART_TOOLTIP_STYLE}
                      formatter={(v, name) => [
                        fmtUSD(v),
                        name === 'strategy' ? 'Strategy' : 'Buy & Hold',
                      ]} />
                    <ReferenceLine y={w.initial_balance} stroke="#8b949e" strokeDasharray="3 2"
                                   label={{ value: fmtUSD(w.initial_balance), position: 'insideTopRight',
                                            fontSize: 10, fill: '#8b949e' }} />
                    <Area type="monotone" dataKey="strategy" stroke="#58a6ff" strokeWidth={1.5}
                          fill="url(#stratGrad)" dot={false} activeDot={{ r: 3, fill: '#58a6ff' }} />
                    {hasBh && (
                      <Area type="monotone" dataKey="buy_and_hold" stroke="#f0883e" strokeWidth={1.5}
                            fill="url(#bhGrad)" dot={false} activeDot={{ r: 3, fill: '#f0883e' }}
                            strokeDasharray="4 2" />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
                {hasBh && (
                  <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, color: 'var(--dim)' }}>
                    <span><span style={{ color: '#58a6ff' }}>—</span> Strategy</span>
                    <span><span style={{ color: '#f0883e' }}>- -</span> Buy &amp; Hold</span>
                    <span style={{ marginLeft: 'auto' }}>
                      Reference line = ${(w.initial_balance ?? 0).toLocaleString()} starting balance
                    </span>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Section 7: Per-ticker breakdown ──────────────────────────── */}
          {report.metrics?.per_ticker?.length > 0 && (
            <div className="explorer-section">
              <div className="section-header">
                <span className="section-badge">7</span>
                <span className="section-label">Per-ticker breakdown</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th style={{ textAlign:'right' }}>Trades</th>
                      <th style={{ textAlign:'right' }}>Win rate</th>
                      <th style={{ textAlign:'right' }}>Avg R</th>
                      <th style={{ textAlign:'right' }}>Sharpe</th>
                      <th style={{ textAlign:'right' }}>Max DD</th>
                      {walletPosSz > 0 && <th style={{ textAlign:'right' }}>$ P&amp;L</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {report.metrics.per_ticker.map(r => {
                      const dpnl = walletPosSz > 0 ? (perTickerDollarPnl[r.ticker] ?? null) : null
                      return (
                      <tr key={r.ticker}>
                        <td><strong>{r.ticker}</strong></td>
                        <td style={{ textAlign:'right' }}>{r.total_trades}</td>
                        <td style={{ textAlign:'right', color: (r.win_rate??0)>=0.5?'var(--green)':'var(--red)' }}>{fmtPct(r.win_rate)}</td>
                        <td style={{ textAlign:'right', color: (r.avg_r_multiple??0)>=0?'var(--green)':'var(--red)' }}>{fmtR(r.avg_r_multiple)}</td>
                        <td style={{ textAlign:'right' }}>{r.sharpe != null ? r.sharpe.toFixed(2) : '—'}</td>
                        <td style={{ textAlign:'right', color:'var(--red)' }}>{r.max_drawdown != null ? r.max_drawdown.toFixed(2)+'R' : '—'}</td>
                        {walletPosSz > 0 && (
                          <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums',
                                       color: dpnl == null ? 'var(--dim)' : dpnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {dpnl == null ? '—' : `${dpnl >= 0 ? '+' : ''}$${Math.abs(dpnl).toFixed(0)}`}
                          </td>
                        )}
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Section 8: Trade list ─────────────────────────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">8</span>
              <span className="section-label">Trade list</span>
              <span className="section-desc">{filteredTrades.length} trades at ≥{liveFloor}% confidence</span>
            </div>
            {filteredTrades.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th><th>Date</th><th>Dir</th><th style={{ textAlign:'right' }}>Conf</th>
                      <th>Source</th><th style={{ textAlign:'right' }}>Entry</th>
                      <th style={{ textAlign:'right' }}>Stop</th><th style={{ textAlign:'right' }}>Target</th>
                      <th>Outcome</th><th style={{ textAlign:'right' }}>R</th>
                      {walletPosSz > 0 && <th style={{ textAlign:'right' }}>$ P&amp;L</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.slice(0, 200).map((t, i) => (
                      <tr key={i} style={{ opacity: (t.confidence??0) < liveFloor ? 0.4 : 1 }}>
                        <td><strong>{t.ticker}</strong></td>
                        <td style={{ fontVariantNumeric:'tabular-nums' }}>{t.signal_date}</td>
                        <td><span className={`badge ${t.type}`}>{t.type}</span></td>
                        <td style={{ textAlign:'right' }}>{t.confidence?.toFixed(0)}%</td>
                        <td style={{ fontSize:11, color:'var(--dim)' }}>{t.source}</td>
                        <td style={{ textAlign:'right' }}>{t.entry?.toFixed(2) ?? '—'}</td>
                        <td style={{ textAlign:'right', color:'var(--red)' }}>{t.stop?.toFixed(2) ?? '—'}</td>
                        <td style={{ textAlign:'right', color:'var(--green)' }}>{t.target?.toFixed(2) ?? '—'}</td>
                        <td style={{ color: t.outcome==='win'?'var(--green)':t.outcome==='loss'?'var(--red)':t.outcome==='cashout'?'var(--yellow)':'var(--dim)' }}
                            title={t.outcome==='cashout'?`Cashout exit at ${t.r_multiple}R — rule locked in profit before reversal`:undefined}>
                          {t.outcome==='cashout'?'💰 cashout':t.outcome ?? '—'}
                        </td>
                        <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums',
                                     color: (t.r_multiple??0)>=0?'var(--green)':'var(--red)' }}>
                          {t.r_multiple != null ? ((t.r_multiple>=0?'+':'')+t.r_multiple.toFixed(2)) : '—'}
                        </td>
                        {walletPosSz > 0 && (() => {
                          const dp = t.exit_date ? tradeDollarPnl(t) : null
                          return (
                            <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums',
                                         color: dp == null ? 'var(--dim)' : dp >= 0 ? 'var(--green)' : 'var(--red)' }}>
                              {dp == null ? '—' : `${dp >= 0 ? '+' : '-'}$${Math.abs(dp).toFixed(0)}`}
                            </td>
                          )
                        })()}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredTrades.length > 200 && (
                  <p style={{ fontSize:11, color:'var(--dim)', padding:'6px 10px' }}>
                    Showing first 200 of {filteredTrades.length} trades.
                  </p>
                )}
              </div>
            ) : (
              <p className="chart-empty">No trades at this confidence floor.</p>
            )}
          </div>

          {/* ── Section 9: AI Review (Feature 4) ─────────────────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">9</span>
              <span className="section-label">AI Review</span>
              <span className="section-desc">Senior trader verdict on these results</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--dim)', marginBottom: 10 }}>
              An LLM acting as a senior, strict-judge trader evaluates the backtest metrics and gives an actionable verdict.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn-primary btn-sm" onClick={runAiReview}
                      disabled={aiReviewLoading || !reportRunId}>
                {aiReviewLoading ? '⏳ Analysing…' : '🧠 Get AI Review'}
              </button>
              <span className="provider-hint" title="💡 Gemini Flash or Mistral · reasoning none">ⓘ</span>
              <button className="btn-primary btn-sm" onClick={runFloorSuggest}
                      disabled={floorSuggestLoading || !reportRunId}
                      title="Ask the AI to assess this run and recommend parameter adjustments">
                {floorSuggestLoading ? '⏳ Thinking…' : '🧪 Experiment Advisor'}
              </button>
              <span className="provider-hint" title="💡 Groq Qwen3.6-27b or Gemini Flash · reasoning low">ⓘ</span>
              {report && (
                <button className="btn-secondary btn-sm"
                        title="Clone these params and flip the LLM mode"
                        onClick={() => cloneRunParams(report, true)}>
                  ↩ Re-run {report.signal_mode === 'llm' ? 'without LLM' : 'with LLM'}
                </button>
              )}
            </div>
            {aiReviewError && (
              <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>✗ {aiReviewError}</p>
            )}
            {floorSuggestError && (
              <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>✗ Experiment Advisor: {floorSuggestError}</p>
            )}
            {floorSuggest && (() => {
              const fs = floorSuggest
              const sc = fs.selected_candidate  // v2 selected candidate object
              const riskColor = { low: 'var(--green)', medium: 'var(--yellow)', high: 'var(--red)' }

              // Map backend change keys → {label, fmt, apply}
              const changeAppliers = {
                confidence_floor: { label: 'Confidence floor', fmt: v => `${v}%`,
                  apply: v => { setConfFloor(Number(v)); setLiveFloor(Number(v)) } },
                max_hold_days:    { label: 'Max hold days',   fmt: v => `${v}d`,  apply: v => setMaxHold(Number(v)) },
                atr_multiple:     { label: 'ATR multiple',    fmt: v => `${v}×`,  apply: v => setAtrMult(Number(v)) },
                reward_risk:      { label: 'Reward / risk',   fmt: v => `${v}:1`, apply: v => setRrRatio(Number(v)) },
              }
              // Current values for comparison
              const currentVals = {
                confidence_floor: report?.confidence_floor ?? confFloor,
                max_hold_days:    report?.max_hold_days    ?? maxHold,
                atr_multiple:     report?.atr_multiple     ?? atrMult,
                reward_risk:      report?.reward_risk      ?? rrRatio,
              }

              return (
                <div style={{
                  marginTop: 14, padding: '14px 16px',
                  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
                }}>
                  {/* header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>🧪 Experiment Advisor</span>
                    {sc?._auto_selected && (
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 600,
                        background: 'var(--yellow)22', color: 'var(--yellow)',
                      }} title="LLM found insufficient evidence for a confident pick; safest candidate shown">
                        ⚠ auto-selected
                      </span>
                    )}
                    {sc?.overfitting_risk && !sc?._auto_selected && (
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 600,
                        background: (riskColor[sc.overfitting_risk] || 'var(--dim)') + '22',
                        color: riskColor[sc.overfitting_risk] || 'var(--dim)',
                      }}>
                        Overfit risk: {sc.overfitting_risk}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>
                      {fs.model_used && `via ${fs.model_used}`}
                      {(fs.prompt_tokens || fs.completion_tokens) && (
                        ` · ${((fs.prompt_tokens ?? 0) + (fs.completion_tokens ?? 0)).toLocaleString()} tok`
                      )}
                    </span>
                  </div>

                  {/* Diagnosis — what failure mode is being addressed */}
                  {fs.diagnosis && (
                    <div style={{ fontSize: 12, color: 'var(--dim)', margin: '0 0 8px',
                      padding: '5px 10px', background: 'var(--surface)', borderRadius: 4 }}>
                      <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Diagnosis: </span>{fs.diagnosis}
                    </div>
                  )}

                  {/* LLM reasoning (why field) — show before hypothesis */}
                  {fs.reasoning && fs.reasoning !== fs.diagnosis && (
                    <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic', margin: '0 0 10px',
                      padding: '6px 10px', background: 'var(--surface)', borderRadius: 4 }}>
                      {fs.reasoning}
                    </p>
                  )}

                  {/* Hypothesis box */}
                  {sc?.hypothesis && (
                    <div style={{
                      padding: '8px 12px', background: 'var(--accent)11',
                      borderLeft: '3px solid var(--accent)', borderRadius: 4, marginBottom: 10,
                      fontSize: 13, fontWeight: 600,
                    }}>
                      {sc.hypothesis}
                    </div>
                  )}

                  {/* Changes: current → suggested */}
                  {sc?.changes && Object.keys(sc.changes).length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 5, marginBottom: 10 }}>
                      {Object.entries(sc.changes).map(([key, val]) => {
                        const meta = changeAppliers[key]
                        if (!meta) return null
                        const cur = currentVals[key]
                        const changed = String(val) !== String(cur)
                        return (
                          <div key={key} style={{
                            display: 'grid', gridTemplateColumns: '130px 1fr auto', gap: 8,
                            alignItems: 'center', padding: '5px 8px',
                            background: changed ? 'var(--accent)0d' : 'transparent', borderRadius: 5,
                          }}>
                            <span style={{ fontSize: 12, color: 'var(--dim)' }}>{meta.label}</span>
                            <span style={{ fontSize: 13 }}>
                              <span style={{ color: 'var(--dim)', textDecoration: 'line-through', marginRight: 6 }}>
                                {meta.fmt(cur)}
                              </span>
                              <span style={{ fontWeight: 700, color: 'var(--accent)' }}>→ {meta.fmt(val)}</span>
                            </span>
                            <button className="btn-secondary btn-sm" style={{ whiteSpace: 'nowrap' }}
                                    onClick={() => meta.apply(val)}>↑ Use</button>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Diagnostic support */}
                  {(sc?.diagnostic_support ?? []).length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--dim)', marginBottom: 3 }}>Evidence</div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--dim)' }}>
                        {sc.diagnostic_support.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    </div>
                  )}

                  {/* Success / failure criteria */}
                  {((sc?.success_criteria ?? []).length > 0 || (sc?.failure_criteria ?? []).length > 0) && (
                    <div style={{ display: 'flex', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
                      {(sc?.success_criteria ?? []).length > 0 && (
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)', marginBottom: 2 }}>✓ Success if</div>
                          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11 }}>
                            {sc.success_criteria.map((s, i) => <li key={i} style={{ color: 'var(--green)' }}>{s}</li>)}
                          </ul>
                        </div>
                      )}
                      {(sc?.failure_criteria ?? []).length > 0 && (
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', marginBottom: 2 }}>✗ Fail if</div>
                          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11 }}>
                            {sc.failure_criteria.map((f, i) => <li key={i} style={{ color: 'var(--red)' }}>{f}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Apply button */}
                  {sc?.changes && (
                    <button className="btn-primary btn-sm" onClick={() => {
                      Object.entries(sc.changes).forEach(([key, val]) => {
                        changeAppliers[key]?.apply(val)
                      })
                      document.querySelector('.bt-params-section')?.scrollIntoView({ behavior: 'smooth' })
                    }}>
                      ✦ Apply & scroll to params
                    </button>
                  )}

                  {/* Next step */}
                  {fs.next_step && (
                    <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8,
                      padding: '5px 10px', background: 'var(--surface)', borderRadius: 4,
                      borderLeft: '2px solid var(--accent)' }}>
                      <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Next: </span>{fs.next_step}
                    </div>
                  )}

                  {/* All candidates — always visible so user can pick manually */}
                  {(fs.candidates ?? []).length > 1 && (
                    <details style={{ marginTop: 12 }}>
                      <summary style={{ fontSize: 11, color: 'var(--dim)', cursor: 'pointer', userSelect: 'none' }}>
                        All {fs.candidates.length} candidates — pick manually
                      </summary>
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {fs.candidates.map(c => {
                          const isSel = c.candidate_id === sc?.candidate_id
                          return (
                            <div key={c.candidate_id} style={{
                              padding: '7px 10px', borderRadius: 6, fontSize: 12,
                              border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border)'}`,
                              background: isSel ? 'var(--accent)0d' : 'var(--surface)',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: 600 }}>{c.hypothesis}</span>
                                <button className="btn-secondary btn-sm" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                                        onClick={() => {
                                          Object.entries(c.changes ?? {}).forEach(([k, v]) => changeAppliers[k]?.apply(v))
                                          document.querySelector('.bt-params-section')?.scrollIntoView({ behavior: 'smooth' })
                                        }}>
                                  ↑ Apply
                                </button>
                              </div>
                              {c.diagnostic_support?.[0] && (
                                <div style={{ color: 'var(--dim)', marginTop: 3 }}>{c.diagnostic_support[0]}</div>
                              )}
                              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                                {Object.entries(c.changes ?? {}).map(([k, v]) => {
                                  const m = changeAppliers[k]
                                  return m ? (
                                    <span key={k} style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
                                      {m.label}: {m.fmt(currentVals[k])} → {m.fmt(v)}
                                    </span>
                                  ) : null
                                })}
                                <span style={{
                                  fontSize: 10, padding: '1px 6px', borderRadius: 99,
                                  background: (riskColor[c.overfitting_risk] || 'var(--dim)') + '22',
                                  color: riskColor[c.overfitting_risk] || 'var(--dim)',
                                }}>
                                  overfit: {c.overfitting_risk ?? '?'}
                                </span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </details>
                  )}
                </div>
              )
            })()}
            {aiReview && (() => {
              const ar = aiReview
              const stageColor = { reject: 'var(--red)', research_only: 'var(--yellow)',
                paper_trade: 'var(--accent)', limited_live_candidate: 'var(--green)' }
              const stageLabel = { reject: '🚫 Reject', research_only: '🔬 Research only',
                paper_trade: '📋 Paper trade', limited_live_candidate: '✅ Live candidate' }
              const edgeColor = ar.edge_assessment === 'positive' ? 'var(--green)'
                : ar.edge_assessment === 'negative' ? 'var(--red)' : 'var(--yellow)'
              const stage = ar.deployment_stage ?? (ar.recommendation === 'deploy' ? 'paper_trade'
                : ar.recommendation === 'discard' ? 'reject' : 'research_only')
              const STAGE_ORDER = ['reject', 'research_only', 'paper_trade', 'limited_live_candidate']
              const stageDesc = {
                reject:                 'Strategy has fatal flaws; do not proceed.',
                research_only:          'In-sample / tuning phase. Experiment to improve metrics.',
                paper_trade:            'Edge demonstrated on OOS data. Simulate with real prices.',
                limited_live_candidate: 'Robust OOS evidence. Ready for small live allocation.',
              }
              return (
                <div style={{ marginTop: 14 }}>
                  {/* ── Deployment stage progression strip ─────────────────── */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--dim)', marginBottom: 6 }}>
                      Deployment stage
                    </div>
                    <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden',
                      border: '1px solid var(--border)' }}>
                      {STAGE_ORDER.map((s, i) => {
                        const isSelected = s === stage
                        const color = stageColor[s] || 'var(--dim)'
                        const icons = { reject: '🚫', research_only: '🔬', paper_trade: '📋', limited_live_candidate: '✅' }
                        const labels = { reject: 'Reject', research_only: 'Research', paper_trade: 'Paper trade', limited_live_candidate: 'Live candidate' }
                        return (
                          <div key={s} title={stageDesc[s]} style={{
                            flex: 1, padding: '7px 4px', textAlign: 'center', cursor: 'default',
                            background: isSelected ? color + '22' : 'var(--surface)',
                            borderRight: i < STAGE_ORDER.length - 1 ? '1px solid var(--border)' : 'none',
                            borderTop: isSelected ? `2px solid ${color}` : '2px solid transparent',
                            transition: 'background 0.15s',
                          }}>
                            <div style={{ fontSize: 13 }}>{icons[s]}</div>
                            <div style={{ fontSize: 10, fontWeight: isSelected ? 700 : 400,
                              color: isSelected ? color : 'var(--dim)', marginTop: 2, lineHeight: 1.2 }}>
                              {labels[s]}
                            </div>
                            {isSelected && (
                              <div style={{ fontSize: 9, marginTop: 2, fontWeight: 700,
                                color, letterSpacing: '0.05em' }}>▲ NOW</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {/* Edge + evidence quality inline below the strip */}
                    <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {ar.edge_assessment && (
                        <span style={{
                          padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          background: edgeColor + '22', color: edgeColor,
                          border: `1px solid ${edgeColor}55`,
                        }}>Edge: {ar.edge_assessment}</span>
                      )}
                      {ar.evidence_quality && (
                        <span style={{ fontSize: 11, color: 'var(--dim)' }}>
                          Evidence: {ar.evidence_quality}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>
                        {ar.model_used && `via ${ar.model_used}`}
                        {(ar.prompt_tokens || ar.completion_tokens) && (
                          ` · ${((ar.prompt_tokens ?? 0) + (ar.completion_tokens ?? 0)).toLocaleString()} tok`
                        )}
                      </span>
                    </div>
                  </div>
                  {ar.verdict && (
                    <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}>{ar.verdict}</p>
                  )}
                  {/* Blocking issues — most critical */}
                  {(ar.blocking_issues ?? []).length > 0 && (
                    <div style={{ marginBottom: 8, padding: '8px 12px', background: 'rgba(248,113,113,0.08)',
                      borderLeft: '3px solid var(--red)', borderRadius: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)', marginBottom: 4 }}>
                        ⛔ Blocking issues
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                        {ar.blocking_issues.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
                      </ul>
                    </div>
                  )}
                  {(ar.strengths ?? []).length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)', marginBottom: 4 }}>✓ Strengths</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                        {ar.strengths.map((s, i) => <li key={i} style={{ marginBottom: 2 }}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  {(ar.weaknesses ?? []).length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>✗ Weaknesses</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                        {ar.weaknesses.map((w, i) => <li key={i} style={{ marginBottom: 2 }}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                  {ar.next_action && (
                    <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic', margin: 0 }}>
                      → {ar.next_action}
                    </p>
                  )}
                </div>
              )
            })()}
          </div>
        </>
      )}

      {/* ── Past runs + comparator ─────────────────────────────────────────── */}
      <div className="explorer-section">
        <div className="section-header">
          <span className="section-badge">📋</span>
          <span className="section-label">Past runs</span>
          <span className="section-desc">Click to load · select multiple for comparator</span>
        </div>
        {pastRuns.length === 0 && <p className="chart-empty">No runs yet.</p>}
        {pastRuns.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th><th>Tickers</th><th>Window</th><th>Mode</th><th>Model</th>
                  <th style={{ textAlign:'right' }} title="Confidence floor · ATR multiple · R:R · Max hold · Scan interval · Cashout">Params</th>
                  <th style={{ textAlign:'right' }}>Win rate</th>
                  <th style={{ textAlign:'right' }}>Avg R</th>
                  <th style={{ textAlign:'right' }}>Trades</th>
                  <th style={{ textAlign:'right' }} title="Wallet: final balance · P&L · cashout trade count">Wallet</th>
                  <th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {pastRuns.map(r => {
                  const m = r.metrics
                  const isOrphaned = !m || m.total_trades == null
                  const tokTotal = (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0)
                  const scanLbl = (() => {
                    const s = r.scan_interval_minutes ?? 1440
                    if (s >= 1440) return 'EOD'
                    if (s >= 60)   return `${s / 60}h`
                    return `${s}m`
                  })()
                  const paramsTitle = [
                    `Floor: ${r.confidence_floor ?? '?'}%`,
                    `ATR: ${r.atr_multiple ?? '?'}×`,
                    `R:R: ${r.reward_risk ?? '?'}:1`,
                    `Hold: ${r.max_hold_days ?? '?'}d`,
                    `Scan: ${scanLbl}`,
                    m?.cashout_r != null ? `Cashout: ${m.cashout_r}R` : null,
                    r.requests_per_minute ? `RPM cap: ${r.requests_per_minute}` : null,
                    r.is_out_of_sample ? 'OOS holdout' : 'In-sample',
                    (r.llm_calls ?? 0) > 0 ? `${fmtTokens(tokTotal)} tok · ${r.llm_calls} calls` : null,
                  ].filter(Boolean).join(' · ')
                  return (
                    <tr key={r.id}
                        style={{
                          cursor: 'pointer',
                          opacity: isOrphaned ? 0.6 : 1,
                          background: loadedRunId === r.id ? 'rgba(88,166,255,0.08)' : undefined,
                          outline: loadedRunId === r.id ? '1px solid rgba(88,166,255,0.35)' : undefined,
                        }}
                        title={isOrphaned ? 'No metrics — run was interrupted or created by an older version' : undefined}
                        onClick={() => loadRun(r.id)}>
                      <td onClick={e => { e.stopPropagation(); toggleCompare(r.id) }}>
                        <input type="checkbox" checked={compareSel.has(r.id)} readOnly
                               style={{ accentColor:'var(--accent)' }} />
                      </td>
                      <td>{(r.tickers ?? []).join(', ')}</td>
                      <td style={{ fontSize:11, color:'var(--dim)', fontVariantNumeric:'tabular-nums' }}>
                        {r.start_date?.slice(5)} → {r.end_date?.slice(5)}
                      </td>
                      <td>
                        <span className={`badge ${r.signal_mode === 'llm' ? 'long' : ''}`}
                              style={r.signal_mode !== 'llm' ? { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' } : {}}>
                          {r.signal_mode === 'llm' ? '🤖 LLM' : '📐 Rules'}
                        </span>
                      </td>
                      <td style={{ fontSize:10, color:'var(--dim)' }}
                          title={r.llm_provider
                            ? `${r.llm_provider} · ${r.llm_model ?? 'model unknown'}`
                            : 'rule-based (no LLM)'}>
                        <div style={{ fontWeight:500 }}>{r.llm_provider ?? '—'}</div>
                        {r.llm_model && (
                          <div style={{ fontSize:9, opacity:0.7, maxWidth:100, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {r.llm_model}
                          </div>
                        )}
                        {tokTotal > 0 && (
                          <div style={{ fontSize:9, opacity:0.55, marginTop:1 }}>
                            {fmtTokens(tokTotal)} tok
                          </div>
                        )}
                      </td>
                      {/* ── Params identity column ── */}
                      <td style={{ textAlign:'right', fontSize:10, color:'var(--dim)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}
                          title={paramsTitle}>
                        <div style={{ display:'flex', flexDirection:'column', gap:1, alignItems:'flex-end' }}>
                          <span title="Confidence floor">
                            🎯 {r.confidence_floor ?? '?'}%
                          </span>
                          <span title="ATR multiple · Reward:Risk">
                            📐 {r.atr_multiple ?? '?'}× · {r.reward_risk ?? '?'}:1
                          </span>
                          <span title="Max hold days">
                            ⏳ {r.max_hold_days ?? '?'}d
                          </span>
                          <span title={`Scan interval: ${r.scan_interval_minutes ?? 1440} min per replay day`}>
                            🔁 {scanLbl}
                          </span>
                          {m?.cashout_r != null && (
                            <span title={`Cashout rule: exit trades early at ${m.cashout_r}R`}
                                  style={{ color: 'var(--yellow)' }}>
                              💰 {m.cashout_r}R
                            </span>
                          )}
                          {r.is_out_of_sample ? (
                            <span style={{ color:'var(--accent)', fontWeight:600 }} title="Out-of-sample holdout">OOS</span>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ textAlign:'right' }}>{fmtPct(m?.win_rate)}</td>
                      <td style={{ textAlign:'right', color: (m?.avg_r_multiple??0)>=0?'var(--green)':'var(--red)' }}>{fmtR(m?.avg_r_multiple)}</td>
                      <td style={{ textAlign:'right' }}>{m?.total_trades ?? '—'}</td>
                      {(() => {
                        const w = m?.wallet
                        if (!w) return <td style={{ textAlign:'right', color:'var(--dim)' }}>—</td>
                        const pnl = w.total_pnl ?? 0
                        const ret = w.total_return_pct ?? 0
                        const finalEq = w.final_equity ?? 0
                        const cashouts = m?.cashout_count ?? 0
                        return (
                          <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums', fontSize: 11 }}
                              title={`Started $${(w.initial_balance??0).toLocaleString()} · Final $${finalEq.toLocaleString()}`}>
                            {/* Final balance — the "money in wallet" */}
                            <div style={{ fontWeight: 600, fontSize: 12,
                                          color: finalEq >= (w.initial_balance ?? 0) ? 'var(--green)' : 'var(--red)' }}>
                              ${Math.round(finalEq).toLocaleString()}
                            </div>
                            {/* P&L delta */}
                            <div style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)', opacity: 0.85 }}>
                              {pnl >= 0 ? '+' : '-'}${Math.abs(Math.round(pnl)).toLocaleString()} ({ret >= 0 ? '+' : ''}{ret.toFixed(1)}%)
                            </div>
                            {/* Cashout trade count */}
                            {cashouts > 0 && (
                              <div style={{ color: 'var(--yellow)', opacity: 0.9 }}>
                                💰 {cashouts} cashout{cashouts > 1 ? 's' : ''}
                              </div>
                            )}
                          </td>
                        )
                      })()}
                      <td style={{ fontSize:11, color: r.status==='done'?'var(--green)':r.status==='error'?'var(--red)':'var(--dim)' }}>{r.status}</td>
                      <td onClick={e => { e.stopPropagation(); deleteRun(r.id) }}>
                        <button className="btn-delete" title="Delete run">×</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Comparator — shown when 2+ runs are selected */}
        {compareRuns.length >= 2 && (
          <div style={{ marginTop: 20 }}>
            <div className="chart-title" style={{ marginBottom: 10 }}>
              Runs comparator — {compareRuns.length} runs selected
            </div>
            {/* Side-by-side metrics */}
            {(() => {
              // Helper: for numeric rows, highlight the best value
              const bestIdx = (vals, higherIsBetter) => {
                if (vals.length < 2) return -1
                const nums = vals.map(v => (v == null || v === '—' || isNaN(Number(v)) ? null : Number(v)))
                if (nums.every(v => v == null)) return -1
                const valid = nums.filter(v => v != null)
                const best = higherIsBetter ? Math.max(...valid) : Math.min(...valid)
                const idx = nums.findIndex(v => v === best)
                return nums.filter(v => v === best).length === 1 ? idx : -1  // no highlight if tied
              }
              const hasWallet = compareRuns.some(r => r.metrics?.wallet)
              const rows = [
                // label, valueFn, rawNumFn (for best-highlighting), higherIsBetter
                ['Period',        r => `${r.start_date?.slice(5)} → ${r.end_date?.slice(5)}`, null, null],
                ['Mode',          r => r.signal_mode === 'llm' ? '🤖 LLM' : '📐 Rules', null, null],
                ['Floor',         r => (r.confidence_floor ?? '—') + '%', null, null],
                ['ATR ×  R:R',    r => `${r.atr_multiple ?? '?'}× · ${r.reward_risk ?? '?'}:1`, null, null],
                ['Max hold',      r => r.max_hold_days != null ? r.max_hold_days + 'd' : '—', null, null],
                ['—', null, null, null],  // divider
                ['Total trades',  r => fmtNum(r.metrics?.total_trades), r => r.metrics?.total_trades, true],
                ['Win rate',      r => fmtPct(r.metrics?.win_rate), r => r.metrics?.win_rate, true],
                ['Avg R',         r => fmtR(r.metrics?.avg_r_multiple), r => r.metrics?.avg_r_multiple, true],
                ['After-cost Avg R', r => r.metrics?.after_cost_avg_r != null ? fmtR(r.metrics.after_cost_avg_r) : '—', r => r.metrics?.after_cost_avg_r, true],
                ['Sharpe',        r => r.metrics?.sharpe != null ? r.metrics.sharpe.toFixed(2) : '—', r => r.metrics?.sharpe, true],
                ['Max drawdown',  r => r.metrics?.max_drawdown != null ? r.metrics.max_drawdown.toFixed(2)+'R' : '—', r => r.metrics?.max_drawdown, false],
                ['Fee stress',    r => r.metrics?.fee_stress_pass != null ? (r.metrics.fee_stress_pass ? '✓ pass' : '✗ fail') : '—', null, null],
                ...(hasWallet ? [
                  ['—', null, null, null],  // divider
                  ['Initial balance', r => r.metrics?.wallet ? `$${(r.metrics.wallet.initial_balance ?? 0).toLocaleString()}` : '—', null, null],
                  ['Position size',   r => r.metrics?.wallet ? `$${(r.metrics.wallet.position_size ?? 0).toLocaleString()} (${((r.metrics.wallet.position_size_pct ?? 0)*100).toFixed(0)}%)` : '—', null, null],
                  ['Final equity',    r => r.metrics?.wallet ? `$${(r.metrics.wallet.final_equity ?? 0).toLocaleString()}` : '—', r => r.metrics?.wallet?.final_equity, true],
                  ['Strategy return', r => r.metrics?.wallet?.total_return_pct != null ? `${r.metrics.wallet.total_return_pct >= 0 ? '+' : ''}${r.metrics.wallet.total_return_pct.toFixed(1)}%` : '—', r => r.metrics?.wallet?.total_return_pct, true],
                  ['Strategy $ P&L',  r => r.metrics?.wallet?.total_pnl != null ? `${r.metrics.wallet.total_pnl >= 0 ? '+' : '-'}$${Math.abs(r.metrics.wallet.total_pnl).toFixed(0)}` : '—', r => r.metrics?.wallet?.total_pnl, true],
                  ['Buy & Hold',      r => r.metrics?.wallet?.buy_and_hold?.return_pct != null ? `${r.metrics.wallet.buy_and_hold.return_pct >= 0 ? '+' : ''}${r.metrics.wallet.buy_and_hold.return_pct.toFixed(1)}%` : '—', r => r.metrics?.wallet?.buy_and_hold?.return_pct, true],
                  ['Alpha vs B&H',    r => {
                    const sp = r.metrics?.wallet?.total_return_pct; const bh = r.metrics?.wallet?.buy_and_hold?.return_pct
                    if (sp == null || bh == null) return '—'
                    const a = sp - bh; return `${a >= 0 ? '+' : ''}${a.toFixed(1)} pp`
                  }, r => { const sp = r.metrics?.wallet?.total_return_pct; const bh = r.metrics?.wallet?.buy_and_hold?.return_pct; return sp != null && bh != null ? sp - bh : null }, true],
                ] : []),
              ]
              return (
              <div className="table-wrap" style={{ marginBottom: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 120 }}>Metric</th>
                      {compareRuns.map((r,i) => (
                        <th key={r.id} style={{ color: BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length], textAlign:'right' }}>
                          Run #{r.id}
                          <div style={{ fontWeight:400, fontSize:10, opacity:0.7 }}>
                            {(r.tickers??[]).join(',')} · {r.signal_mode === 'llm' ? 'LLM' : 'Rules'}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([label, fn, numFn, higherIsBetter], ri) => {
                      if (label === '—') return (
                        <tr key={ri}><td colSpan={compareRuns.length + 1} style={{ padding: '2px 0', borderTop: '1px solid var(--border)' }}></td></tr>
                      )
                      const vals = compareRuns.map(r => fn(r))
                      const rawNums = numFn ? compareRuns.map(r => numFn(r)) : null
                      const best = rawNums ? bestIdx(rawNums, higherIsBetter) : -1
                      return (
                        <tr key={label}>
                          <td style={{ color:'var(--dim)', fontSize:12 }}>{label}</td>
                          {compareRuns.map((r, ci) => (
                            <td key={r.id} style={{
                              textAlign:'right',
                              fontWeight: best === ci ? 700 : 400,
                              color: best === ci ? 'var(--green)' : undefined,
                            }}>{vals[ci]}</td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              )
            })()}

            {/* Overlaid cumulative-R curves */}
            <div className="chart-title" style={{ marginBottom: 6 }}>Cumulative R — overlaid</div>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={compareChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                <XAxis dataKey="i" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                       width={38} tickFormatter={v => v.toFixed(1)+'R'} />
                <Tooltip {...CHART_TOOLTIP_STYLE}
                  formatter={(v, name) => [fmtR(v), name.replace('run_', 'Run #')]} />
                <ReferenceLine y={0} stroke="#8b949e" strokeDasharray="3 2" />
                {compareRuns.map((r, i) => (
                  <Area key={r.id} type="monotone" dataKey={`run_${r.id}`}
                    stroke={BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}
                    fill={`${BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}22`}
                    strokeWidth={1.5} dot={false} connectNulls />
                ))}
              </AreaChart>
            </ResponsiveContainer>

            {/* Overlaid $ equity curves — only when wallet data is present */}
            {compareDollarChartData.length > 0 && compareRuns.some(r => r.metrics?.wallet?.dollar_equity_curve?.length) && (
              <>
                <div className="chart-title" style={{ marginBottom: 6, marginTop: 14 }}>$ Portfolio equity — overlaid</div>
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={compareDollarChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                    <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                    <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                           width={56} tickFormatter={v => '$'+Math.round(v).toLocaleString()} />
                    <Tooltip {...CHART_TOOLTIP_STYLE}
                      formatter={(v, name) => [`$${Number(v).toLocaleString()}`, name.replace('run_', 'Run #')]} />
                    {compareRuns.filter(r => r.metrics?.wallet).map((r, i) => {
                      const init = r.metrics.wallet.initial_balance ?? 0
                      return <ReferenceLine key={`ref_${r.id}`} y={init} stroke={BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]} strokeDasharray="3 2" strokeOpacity={0.4} />
                    })}
                    {compareRuns.map((r, i) => (
                      r.metrics?.wallet?.dollar_equity_curve?.length ? (
                        <Area key={r.id} type="monotone" dataKey={`run_${r.id}`}
                          stroke={BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}
                          fill={`${BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}22`}
                          strokeWidth={1.5} dot={false} connectNulls />
                      ) : null
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </>
            )}

            {/* AI Compare */}
            {(() => {
              const hasLlmVsRules =
                compareRuns.some(r => r.signal_mode === 'llm') &&
                compareRuns.some(r => r.signal_mode === 'rules')
              return (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <button className="btn-primary btn-sm" onClick={runAiCompare}
                            disabled={aiCompareLoading}>
                      {aiCompareLoading ? '⏳ Comparing…' : '🧠 AI Compare'}
                    </button>
                    <span className="provider-hint" title="💡 Groq Qwen3.6-27b · reasoning default">ⓘ</span>
                    {hasLlmVsRules && (
                      <span className="badge" style={{
                        background: 'rgba(251,191,36,0.18)', color: 'var(--yellow)',
                        border: '1px solid rgba(251,191,36,0.35)', fontSize: 11,
                      }}>⚡ LLM vs Rules</span>
                    )}
                  </div>
                  {aiCompareError && (
                    <p style={{ color: 'var(--red)', fontSize: 13 }}>✗ {aiCompareError}</p>
                  )}
                  {aiCompare && (
                    <div style={{
                      padding: '12px 16px', background: 'var(--surface-2)',
                      border: '1px solid var(--border)', borderRadius: 8,
                    }}>
                      {/* Header row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                        {/* Comparability badge */}
                        {aiCompare.comparability && (
                          <span style={{
                            padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                            background: aiCompare.comparability === 'full' ? 'rgba(52,211,153,0.15)'
                              : aiCompare.comparability === 'partial' ? 'rgba(251,191,36,0.15)'
                              : 'rgba(248,113,113,0.15)',
                            color: aiCompare.comparability === 'full' ? 'var(--green)'
                              : aiCompare.comparability === 'partial' ? 'var(--yellow)' : 'var(--red)',
                          }}>
                            {aiCompare.comparability === 'full' ? '✓ Fully comparable'
                              : aiCompare.comparability === 'partial' ? '⚠ Partially comparable'
                              : '✗ Not comparable'}
                          </span>
                        )}
                        {/* Winner badge */}
                        {aiCompare.winner_run_id != null && (
                          <span style={{
                            padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                            background: 'rgba(52,211,153,0.18)', color: 'var(--green)',
                            border: '1px solid rgba(52,211,153,0.3)',
                          }}>
                            🏆 Run #{aiCompare.winner_run_id} wins
                            {aiCompare.winner_confidence && aiCompare.winner_confidence !== 'none' && (
                              <span style={{ fontWeight: 400, marginLeft: 5, fontSize: 11 }}>
                                ({aiCompare.winner_confidence} confidence)
                              </span>
                            )}
                          </span>
                        )}
                        <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>
                          {aiCompare.model_used && `via ${aiCompare.model_used}`}
                          {(aiCompare.prompt_tokens || aiCompare.completion_tokens) && (
                            ` · ${((aiCompare.prompt_tokens ?? 0) + (aiCompare.completion_tokens ?? 0)).toLocaleString()} tok`
                          )}
                        </span>
                      </div>
                      {/* LLM value-add */}
                      {aiCompare.llm_value_add?.assessment && aiCompare.llm_value_add.assessment !== 'not_applicable' && (
                        <div style={{
                          fontSize: 12, marginBottom: 10, padding: '6px 10px',
                          background: 'var(--surface-1)', borderRadius: 6,
                        }}>
                          <span style={{ fontWeight: 600, marginRight: 6 }}>LLM vs Rules:</span>
                          <span style={{
                            fontWeight: 700,
                            color: aiCompare.llm_value_add.assessment === 'adds' ? 'var(--green)'
                              : aiCompare.llm_value_add.assessment === 'detracts' ? 'var(--red)'
                              : 'var(--dim)',
                          }}>{aiCompare.llm_value_add.assessment}</span>
                          {aiCompare.llm_value_add.reason && (
                            <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
                              — {aiCompare.llm_value_add.reason}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Summary */}
                      {aiCompare.summary && (
                        <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>{aiCompare.summary}</p>
                      )}
                      {/* Per-run */}
                      {(aiCompare.per_run ?? []).map((pr, i) => (
                        <div key={pr.run_id} style={{ marginBottom: 10 }}>
                          <div style={{
                            fontSize: 12, fontWeight: 600, marginBottom: 4,
                            color: BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length],
                          }}>
                            Run #{pr.run_id}
                            {pr.evidence_quality && (
                              <span style={{ fontWeight: 400, color: 'var(--dim)', marginLeft: 6 }}>
                                · {pr.evidence_quality} evidence
                              </span>
                            )}
                          </div>
                          {(pr.strengths ?? []).length > 0 && (
                            <ul style={{ margin: '0 0 4px', paddingLeft: 18, fontSize: 12 }}>
                              {pr.strengths.map((s, j) => (
                                <li key={j} style={{ color: 'var(--green)', marginBottom: 1 }}>{s}</li>
                              ))}
                            </ul>
                          )}
                          {(pr.weaknesses ?? []).length > 0 && (
                            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                              {pr.weaknesses.map((w, j) => (
                                <li key={j} style={{ color: 'var(--red)', marginBottom: 1 }}>{w}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                      {/* Recommendation */}
                      {aiCompare.recommendation && (
                        <p style={{ fontSize: 13, fontWeight: 600, margin: '8px 0 0' }}>
                          → {aiCompare.recommendation}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>

    </div>
  )
}

// ─── Paper Orders Panel ───────────────────────────────────────────────────────

function PaperOrdersPanel({ open, onToggle, onOrderClick }) {
  const [account,      setAccount]      = useState(null)
  const [clock,        setClock]        = useState(null)
  const [orders,       setOrders]       = useState([])
  const [positions,    setPositions]    = useState([])
  const [paperEnabled, setPaperEnabled] = useState(null)   // null = unknown, true/false = known
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState(null)
  const [cancelling,   setCancelling]   = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [accRes, clkRes, ordRes, posRes, cfgRes] = await Promise.all([
        fetch(`${API}/paper/account`,    { headers: getAuthHeaders() }),
        fetch(`${API}/paper/clock`,      { headers: getAuthHeaders() }),
        fetch(`${API}/paper/orders`,     { headers: getAuthHeaders() }),
        fetch(`${API}/paper/positions`,  { headers: getAuthHeaders() }),
        fetch(`${API}/settings`,         { headers: getAuthHeaders() }),
      ])
      if (accRes.ok) { const d = await accRes.json(); setAccount(d.account ?? null) }
      if (clkRes.ok) setClock(await clkRes.json())
      if (ordRes.ok)  setOrders((await ordRes.json()).orders ?? [])
      if (posRes.ok)  setPositions((await posRes.json()).positions ?? [])
      if (cfgRes.ok) { const d = await cfgRes.json(); setPaperEnabled(d.paper_trading_enabled ?? false) }
    } catch (e) {
      setError('Failed to load paper data')
    } finally {
      setLoading(false)
    }
  }, [])

  // Load on mount and poll every 60 s
  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const cancelOrder = async (dbId, alpacaId) => {
    setCancelling(c => ({ ...c, [dbId]: true }))
    try {
      await fetch(`${API}/paper/orders/${dbId}/cancel`, { method: 'POST', headers: getAuthHeaders() })
      await load()
    } finally {
      setCancelling(c => { const n = { ...c }; delete n[dbId]; return n })
    }
  }

  const fmtMoney = (v, decimals = 2) =>
    v == null ? '—' : `$${parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`

  const fmtPct = (v) =>
    v == null ? '' : `${v >= 0 ? '+' : ''}${parseFloat(v).toFixed(2)}%`

  const statusChip = (status) => {
    const map = {
      pending:           { bg: '#7c6200', color: '#ffd54f' },
      accepted:          { bg: '#7c6200', color: '#ffd54f' },
      accepted_for_bidding: { bg: '#7c6200', color: '#ffd54f' },
      new:               { bg: '#7c6200', color: '#ffd54f' },
      filled:            { bg: '#1b4332', color: '#69db7c' },
      partially_filled:  { bg: '#1b4332', color: '#69db7c' },
      cancelled:         { bg: '#333', color: '#888' },
      canceled:          { bg: '#333', color: '#888' },
      expired:           { bg: '#333', color: '#888' },
      rejected:          { bg: '#5c1a1a', color: '#fc9a9a' },
    }
    const style = map[status] ?? { bg: '#333', color: '#aaa' }
    return (
      <span style={{
        padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600,
        background: style.bg, color: style.color, textTransform: 'uppercase',
      }}>
        {status ?? 'unknown'}
      </span>
    )
  }

  const isPending = (s) => ['pending','new','accepted','accepted_for_bidding','partially_filled'].includes(s)

  if (!open) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', paddingTop: 8 }}>
        <button
          onClick={onToggle}
          title="Show Paper Orders"
          style={{
            background: 'none', border: '1px solid #333', borderRadius: 6,
            color: '#888', cursor: 'pointer', padding: '6px 10px', fontSize: 18,
            lineHeight: 1, writingMode: 'vertical-rl',
          }}
        >
          📈
        </button>
      </div>
    )
  }

  return (
    <div style={{
      width: 260, minWidth: 260, flexShrink: 0,
      background: 'var(--surface)', border: '1px solid #333',
      borderRadius: 10, padding: '12px 14px', display: 'flex',
      flexDirection: 'column', gap: 10, alignSelf: 'flex-start',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📈 Paper Orders</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {loading && <span style={{ fontSize: 11, color: '#888' }}>↻</span>}
          <button
            onClick={load}
            title="Refresh"
            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 13, padding: 0 }}
          >⟳</button>
          <button
            onClick={onToggle}
            title="Collapse"
            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 13, padding: 0 }}
          >◀</button>
        </div>
      </div>

      {error && <div style={{ fontSize: 11, color: '#fc9a9a' }}>{error}</div>}

      {/* Paper trading enabled/disabled badge */}
      {paperEnabled !== null && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '5px 9px', borderRadius: 6, fontSize: 11,
          background: paperEnabled ? 'color-mix(in srgb, #69db7c 12%, transparent)' : 'color-mix(in srgb, #fc9a9a 10%, transparent)',
          border: `1px solid ${paperEnabled ? 'color-mix(in srgb, #69db7c 30%, transparent)' : 'color-mix(in srgb, #fc9a9a 25%, transparent)'}`,
          color: paperEnabled ? '#69db7c' : '#fc9a9a',
        }}>
          <span style={{ fontSize: 9 }}>{paperEnabled ? '●' : '○'}</span>
          <span style={{ fontSize: 10 }}>{paperEnabled ? 'Auto-trading enabled — orders placed on signals' : 'Auto-trading disabled — enable in Settings → Paper Trading'}</span>
        </div>
      )}

      {/* Account summary */}
      {account && (
        <div style={{ borderRadius: 7, background: '#1a1a2a', padding: '8px 10px', fontSize: 12 }}>
          <div style={{ color: '#888', fontSize: 10, textTransform: 'uppercase', marginBottom: 6, letterSpacing: 1 }}>Account</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: '#aaa' }}>Equity</span>
            <span style={{ fontWeight: 600 }}>{fmtMoney(account.equity)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: '#aaa' }}>Day P&amp;L</span>
            <span style={{ color: (account.day_pnl ?? 0) >= 0 ? '#69db7c' : '#fc9a9a', fontWeight: 600 }}>
              {(account.day_pnl ?? 0) >= 0 ? '+' : ''}{fmtMoney(account.day_pnl)}
              {account.day_pnl_pct != null && (
                <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.8 }}>
                  ({fmtPct(account.day_pnl_pct)})
                </span>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: '#aaa' }}>Cash</span>
            <span>{fmtMoney(account.cash)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: '#aaa' }}>Buying Power</span>
            <span>{fmtMoney(account.buying_power)}</span>
          </div>
          {(account.long_market_value > 0 || account.short_market_value > 0) && (
            <div style={{ borderTop: '1px solid #2a2a3a', marginTop: 5, paddingTop: 5 }}>
              {account.long_market_value > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ color: '#aaa' }}>Long exposure</span>
                  <span style={{ color: '#69db7c' }}>{fmtMoney(account.long_market_value)}</span>
                </div>
              )}
              {account.short_market_value < 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ color: '#aaa' }}>Short exposure</span>
                  <span style={{ color: '#fc9a9a' }}>{fmtMoney(Math.abs(account.short_market_value))}</span>
                </div>
              )}
              {account.maintenance_margin > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#aaa' }}>Maint. margin</span>
                  <span style={{ color: '#888' }}>{fmtMoney(account.maintenance_margin)}</span>
                </div>
              )}
            </div>
          )}
          {account.daytrade_count > 0 && (
            <div style={{ marginTop: 5, fontSize: 10, color: account.daytrade_count >= 3 ? '#fc9a9a' : '#ffd54f' }}>
              ⚠ {account.daytrade_count}/3 day trades (rolling 5 days)
            </div>
          )}
        </div>
      )}

      {/* Open positions */}
      {positions.length > 0 && (
        <div>
          <div style={{ color: '#888', fontSize: 10, textTransform: 'uppercase', marginBottom: 6, letterSpacing: 1 }}>Open Positions</div>
          {positions.map((p, i) => {
            const pnl = parseFloat(p.unrealized_pl ?? 0)
            const pnlPct = parseFloat(p.unrealized_plpc ?? 0) * 100
            return (
              <div key={i} style={{
                padding: '6px 8px', borderRadius: 6, background: '#1a1a2a',
                marginBottom: 4, fontSize: 12,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontWeight: 700 }}>{p.symbol}</span>
                  <span style={{ color: '#aaa', fontSize: 11 }}>{p.side} · {fmtMoney(p.market_value, 0)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#888', fontSize: 11 }}>Avg {fmtMoney(p.avg_entry_price)}</span>
                  <span style={{ color: pnl >= 0 ? '#69db7c' : '#fc9a9a', fontSize: 11, fontWeight: 600 }}>
                    {pnl >= 0 ? '+' : ''}{fmtMoney(pnl)} ({fmtPct(pnlPct)})
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Recent orders */}
      <div>
        <div style={{ color: '#888', fontSize: 10, textTransform: 'uppercase', marginBottom: 6, letterSpacing: 1 }}>Recent Orders</div>
        {orders.length === 0 && !loading && (
          <div style={{ color: '#555', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>No orders yet</div>
        )}
        {orders.slice(0, 20).map((o) => (
          <div
            key={o.id}
            onClick={() => onOrderClick?.(o.id)}
            style={{
              padding: '6px 8px', borderRadius: 6, background: '#1a1a2a',
              marginBottom: 4, fontSize: 12,
              cursor: onOrderClick ? 'pointer' : 'default',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { if (onOrderClick) e.currentTarget.style.background = '#1e2235' }}
            onMouseLeave={e => { if (onOrderClick) e.currentTarget.style.background = '#1a1a2a' }}
            title={onOrderClick ? 'Click to view on Trading page' : undefined}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span style={{ fontWeight: 700 }}>{o.ticker}</span>
                <span style={{ fontSize: 10, color: o.side === 'buy' ? '#69db7c' : '#fc9a9a' }}>
                  {o.side === 'buy' ? '↑ LONG' : '↓ SHORT'}
                </span>
              </div>
              {statusChip(o.status)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#888', fontSize: 11 }}>
                {fmtMoney(o.notional, 0)} notional
                {o.filled_avg_price ? ` · fill ${fmtMoney(o.filled_avg_price)}` : ''}
              </span>
              {isPending(o.status) && (
                <button
                  onClick={() => cancelOrder(o.id, o.alpaca_order_id)}
                  disabled={cancelling[o.id]}
                  title="Cancel order"
                  style={{
                    background: 'none', border: '1px solid #555', borderRadius: 4,
                    color: '#fc9a9a', cursor: 'pointer', fontSize: 10, padding: '1px 5px',
                  }}
                >
                  {cancelling[o.id] ? '…' : '✕'}
                </button>
              )}
            </div>
            {/* Realised P&L for closed orders */}
            {o.realized_pnl != null && (
              <div style={{ fontSize: 11, color: parseFloat(o.realized_pnl) >= 0 ? '#69db7c' : '#fc9a9a', marginTop: 2 }}>
                P&amp;L {parseFloat(o.realized_pnl) >= 0 ? '+' : ''}{fmtMoney(o.realized_pnl)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Login screen ─────────────────────────────────────────────────────────────

const LOGIN_TICKER_TAPE = ['SPY +0.34%','AAPL +1.2%','NVDA -0.8%','TSLA +2.1%','BTC +3.4%','MSFT +0.6%','ACN +1.7%','AMZN -0.3%','META +1.8%','EUROB +4.2%','GOOG +0.9%','GLD -0.2%','QQQ +0.7%','JPM +0.4%']
const LOGIN_LOGS = [
  '> Connecting to market data feed…',
  '> Authenticated with Alpaca Paper API ✓',
  '> Loading LLM inference engine…',
  '> Multi-timeframe RSI engine ready ✓',
  '> Macro regime filter online ✓',
  '> Opportunity scanner armed ✓',
  '> All systems nominal. Awaiting operator clearance.',
]

function LoginScreen({ onLogin }) {
  const [input, setInput]     = useState('')
  const [err, setErr]         = useState('')
  const [loading, setLoading] = useState(false)
  const [devMode, setDevMode] = useState(null)
  const [logLines, setLogLines] = useState([])
  const [shake, setShake]       = useState(false)
  const inputRef = useRef(null)

  // Boot log animation
  useEffect(() => {
    let i = 0
    const t = setInterval(() => {
      setLogLines(prev => [...prev, LOGIN_LOGS[i]])
      i++
      if (i >= LOGIN_LOGS.length) clearInterval(t)
    }, 420)
    return () => clearInterval(t)
  }, [])

  // Dev mode probe
  useEffect(() => {
    fetch(`${API}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: '' }) })
      .then(r => r.json()).then(d => { if (d.dev_mode) setDevMode(true) }).catch(() => {})
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true); setErr('')
    try {
      const r = await fetch(`${API}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: input }),
      })
      if (r.ok) {
        sessionStorage.setItem('admin_token', input)
        onLogin()
      } else {
        setErr('ACCESS DENIED — invalid credentials')
        setShake(true)
        setTimeout(() => setShake(false), 600)
        inputRef.current?.select()
      }
    } catch {
      setErr('OFFLINE — backend unreachable')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: '#0a0f0a', overflow: 'hidden', zIndex: 9999 }}>

      {/* ══ Full-width ticker tape ══ */}
      <div style={{ overflow: 'hidden', background: '#001a00', borderBottom: '1px solid #00ff4125', padding: '6px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 40, whiteSpace: 'nowrap', animation: 'loginTicker 22s linear infinite', fontFamily: '"Courier New", monospace', fontSize: 11, color: '#00ff41', letterSpacing: '0.5px' }}>
          {[...LOGIN_TICKER_TAPE, ...LOGIN_TICKER_TAPE].map((t, i) => (
            <span key={i} style={{ color: t.includes('-') ? '#ff4444' : '#00ff41' }}>{t}</span>
          ))}
        </div>
      </div>

      {/* ══ Panels row ══ */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* ══ LEFT — hacker branding ══ */}
      <div style={{ width: 420, flexShrink: 0, background: '#0a0f0a', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', borderRight: '1px solid #00ff4120' }}>

        {/* CRT scanline overlay */}
        <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.18) 2px, rgba(0,0,0,.18) 4px)', zIndex: 10 }} />

        {/* Body */}
        <div style={{ flex: 1, padding: '28px 36px', display: 'flex', flexDirection: 'column', gap: 20, position: 'relative', zIndex: 1 }}>

          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, border: '1px solid #00cc33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: '0 0 8px #00ff4130' }}>📈</div>
            <span style={{ fontFamily: '"Courier New", monospace', fontSize: 14, color: '#00ff41', textShadow: '0 0 10px #00ff4180', letterSpacing: 3, textTransform: 'uppercase' }}>OffGrid&nbsp;Trader</span>
          </div>

          {/* Tagline */}
          <div style={{ fontFamily: '"Courier New", monospace', color: '#00cc33', fontSize: 22, fontWeight: 'bold', lineHeight: 1.3, textShadow: '0 0 15px #00ff4140' }}>
            Algorithmic signals,<br /><span style={{ color: '#38bdf8', textShadow: '0 0 10px #38bdf850' }}>institutional edge.</span>
          </div>

          <div style={{ fontFamily: '"Courier New", monospace', fontSize: 12, color: '#4a8f5a', lineHeight: 1.7, maxWidth: 380 }}>
            Multi-timeframe RSI · macro regime filtering<br />
            LLM-powered analysis · Alpaca paper execution<br />
            Running 24/7. Waiting for your clearance.
          </div>

          {/* Boot log box */}
          <div style={{ border: '1px solid #00ff4115', background: '#020a02', padding: '14px 16px', borderRadius: 2, display: 'flex', flexDirection: 'column', gap: 4, minHeight: 140 }}>
            {logLines.map((l, i) => (
              <div key={i} style={{ fontFamily: '"Courier New", monospace', fontSize: 11, color: l?.startsWith('> All') || l?.includes('✓') ? '#00cc33' : l?.includes('armed') ? '#ffcc00' : '#4a8f5a', opacity: i === logLines.length - 1 ? 1 : 0.8, whiteSpace: 'nowrap' }}>{l}</div>
            ))}
            {logLines.length < LOGIN_LOGS.length && (
              <span style={{ fontFamily: '"Courier New", monospace', fontSize: 11, color: '#00ff41', animation: 'loginBlink 1s step-end infinite' }}>█</span>
            )}
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 24, marginTop: 'auto', paddingTop: 16, borderTop: '1px solid #00ff4115' }}>
            {[['15m','Scan int.'],['3×','Timeframes'],['LLM','AI-backed']].map(([v,l]) => (
              <div key={l}>
                <div style={{ fontFamily: '"Courier New", monospace', fontSize: 20, color: '#00ff41', textShadow: '0 0 8px #00ff4160' }}>{v}</div>
                <div style={{ fontFamily: '"Courier New", monospace', fontSize: 10, color: '#3a5a3a', textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Status bar */}
        <div style={{ fontFamily: '"Courier New", monospace', fontSize: 10, color: '#2a4a2a', background: '#010501', padding: '5px 36px', borderTop: '1px solid #00ff4112', letterSpacing: '0.5px', flexShrink: 0, zIndex: 1 }}>
          SYS: <span style={{ color: '#00cc33' }}>NOMINAL</span> &nbsp;|&nbsp; DB: <span style={{ color: '#00cc33' }}>CONNECTED</span> &nbsp;|&nbsp; STREAM: <span style={{ color: '#00cc33' }}>LIVE</span> &nbsp;|&nbsp; v2.3.0
        </div>
      </div>

      {/* ══ RIGHT — hacker form panel ══ */}
      <div style={{ flex: 1, background: '#050a05', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '48px 44px', position: 'relative', borderLeft: '1px solid #00ff4115' }}>

        {/* scanlines on right too */}
        <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.18) 2px, rgba(0,0,0,.18) 4px)' }} />

        <div style={{ width: '100%', maxWidth: 400, position: 'relative', zIndex: 1 }}>

          {/* Terminal title bar */}
          <div style={{ background: '#001a00', border: '1px solid #00ff4130', borderBottom: 'none', borderRadius: '4px 4px 0 0', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#febc2e', display: 'inline-block' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840', display: 'inline-block' }} />
            <span style={{ marginLeft: 8, fontSize: 10, color: '#00ff4160', letterSpacing: 2, fontFamily: '"Courier New", monospace' }}>SECURE TERMINAL — AUTH</span>
          </div>

          {/* Card body */}
          <div style={{ border: '1px solid #00ff4130', borderRadius: '0 0 4px 4px', background: '#020a02', boxShadow: '0 0 30px #00ff4115, 0 0 60px #00ff4108', animation: shake ? 'loginShake 0.5s' : undefined }}>

            {/* Operator header */}
            <div style={{ padding: '18px 20px 0', fontFamily: '"Courier New", monospace' }}>
              <div style={{ fontSize: 10, color: '#00ff4160', letterSpacing: 2, marginBottom: 4 }}>
                {devMode ? '// DEV MODE — no credentials required' : '// OPERATOR CLEARANCE REQUIRED'}
              </div>
              <div style={{ fontSize: 18, color: '#00ff41', textShadow: '0 0 10px #00ff4160', marginBottom: 2 }}>Access Terminal</div>
              <div style={{ fontSize: 11, color: '#3a6a3a', marginBottom: 16 }}>Enter your admin token to authenticate.</div>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} style={{ padding: '0 20px 20px', fontFamily: '"Courier New", monospace' }}>

              <div style={{ fontSize: 10, color: '#3a6a3a', letterSpacing: 1, marginBottom: 6 }}>ACCESS_TOKEN</div>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ color: '#00ff41', fontSize: 14, padding: '9px 10px', background: '#001a00', border: '1px solid #00ff4140', borderRight: 'none', borderRadius: '3px 0 0 3px', flexShrink: 0 }}>$</span>
                <input
                  ref={inputRef}
                  type="password"
                  value={input}
                  onChange={e => { setInput(e.target.value); setErr('') }}
                  placeholder={devMode ? 'press ENTER to continue' : 'enter access token…'}
                  autoFocus
                  autoComplete="current-password"
                  style={{
                    flex: 1, padding: '9px 12px',
                    background: '#001a00', color: '#00ff41',
                    border: '1px solid #00ff4140', borderRight: 'none',
                    outline: 'none', fontSize: 13,
                    fontFamily: 'inherit', letterSpacing: 2,
                  }}
                />
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    padding: '9px 16px', background: loading ? '#001a00' : '#00ff4115',
                    color: '#00ff41', border: '1px solid #00ff4140',
                    borderRadius: '0 3px 3px 0', cursor: loading ? 'not-allowed' : 'pointer',
                    fontSize: 12, fontFamily: 'inherit', letterSpacing: 2,
                    transition: 'background 0.2s', flexShrink: 0,
                  }}
                >{loading ? '…' : 'AUTH'}</button>
              </div>

              {err && (
                <div style={{ fontSize: 11, color: '#ff4444', letterSpacing: 1, marginBottom: 10, animation: 'loginBlink 0.3s 2' }}>
                  ⚠ {err}
                </div>
              )}

              <div style={{ borderTop: '1px solid #00ff4112', paddingTop: 14, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#2a4a2a', letterSpacing: 0.5 }}>
                <span>SYS:NOMINAL&nbsp;|&nbsp;DB:OK</span>
                <span>UNAUTHORIZED ACCESS PROSECUTED</span>
              </div>
            </form>
          </div>
        </div>
      </div>

      </div>{/* /panels row */}

      <style>{`
        @keyframes loginBlink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes loginTicker { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        @keyframes loginShake {
          0%,100%{transform:translateX(0)}
          20%{transform:translateX(-8px)} 40%{transform:translateX(8px)}
          60%{transform:translateX(-5px)} 80%{transform:translateX(5px)}
        }
      `}</style>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [authed, setAuthed] = useState(() => !!sessionStorage.getItem('admin_token'))

  // Re-login when the backend rejects our token (e.g. after ADMIN_TOKEN rotation).
  // signal401() fires 'auth-expired' from usePolling / readSSEStream on any HTTP 401.
  useEffect(() => {
    const handler = () => setAuthed(false)
    window.addEventListener('auth-expired', handler)
    return () => window.removeEventListener('auth-expired', handler)
  }, [])

  const { data: health, reload: reloadHealth }  = usePolling('/health', 30_000)
  const { data: wl, reload: reloadWatchlist }   = usePolling('/watchlist', 60_000)
  const { data: signals, reload: reloadSignals } = usePolling('/signals?limit=30', 60_000)
  // Token usage — 30-day window; drives header chip + settings section
  const { data: usage, reload: reloadUsage }    = usePolling('/usage', 60_000)
  // Market clock — drives the header "US Market Open/Closed · closes in Xm" pill
  const { data: paperClock }                    = usePolling('/paper/clock', 60_000)
  // Paper orders — used to show existing order status on signal cards
  const { data: dashPaperOrders }               = usePolling('/paper/orders?limit=200', 60_000)
  // Backtest runs list — used to include LLM backtest tokens in the header chip
  const { data: btListData }                    = usePolling('/backtest', 60_000)
  const btTodayTokens = (() => {
    const todayIso     = new Date().toISOString().slice(0, 10)
    const activeModel  = usage?.active_model    ?? null
    const activeProv   = usage?.active_provider ?? null
    return (btListData?.runs ?? [])
      .filter(r =>
        (r.created_at ?? '').slice(0, 10) === todayIso &&
        // filter to active model when we have provider info; otherwise sum all
        (!activeProv || (r.llm_provider ?? null) === activeProv) &&
        (!activeModel || (r.llm_model   ?? null) === activeModel)
      )
      .reduce((s, r) => s + (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0), 0)
  })()

  const [activeView, setActiveView] = useState('dashboard')
  const [explorerState, setExplorerState] = useState(null)
  // When a sidebar order row is clicked, navigate to Trading and pre-expand that order
  const [tradingExpandOrder, setTradingExpandOrder] = useState(null)
  // Increment to force-remount ExplorerPage only when a new result arrives from Dashboard.
  // Tab switching leaves explorerKey unchanged so the running SSE stream is preserved.
  const [explorerKey, setExplorerKey] = useState(0)

  // Paper orders panel — open state persisted to localStorage
  const [paperPanelOpen, setPaperPanelOpen] = useState(() => {
    try { return localStorage.getItem('paper_panel_open') !== 'false' }
    catch { return true }
  })
  const togglePaperPanel = () => {
    setPaperPanelOpen(v => {
      const next = !v
      try { localStorage.setItem('paper_panel_open', String(next)) } catch {}
      return next
    })
  }

  const openExplorer = (result) => {
    setExplorerState(result)
    setExplorerKey(k => k + 1)   // reset Explorer state for the new result
    setActiveView('explorer')
  }

  // Auth gate — must come after all hooks so hook call order is stable.
  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />

  return (
    <div className="app">
      <Header health={health} usage={usage} btTodayTokens={btTodayTokens} activeView={activeView} onViewChange={setActiveView} clock={paperClock} />
      <main className="main">
        {/* All three views are always mounted — switching tabs never destroys SSE state */}
        <div style={{ display: activeView === 'dashboard' ? 'flex' : 'none',
                      flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <PaperOrdersPanel
            open={paperPanelOpen}
            onToggle={togglePaperPanel}
            onOrderClick={(orderId) => {
              setTradingExpandOrder(orderId)
              setActiveView('paper')
            }}
          />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Dashboard info bar */}
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center',
              padding: '7px 14px', borderRadius: 8,
              background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
              fontSize: 12, color: 'var(--dim)',
            }}>
              <span>📊 <strong>Live prices</strong> refresh every 30 s via Alpaca</span>
              <span style={{ color: 'color-mix(in srgb, var(--dim) 40%, transparent)' }}>·</span>
              {(() => {
                const scanMin = wl?.scheduler?.scan_interval_minutes ?? wl?.scan_interval_minutes ?? 15
                // Derive next-run from last_run + current interval (avoids stale value
                // during the current sleep cycle when the interval was just changed).
                const lastRunIso = wl?.scheduler?.last_run
                const nextRunDerived = lastRunIso
                  ? new Date(new Date(lastRunIso).getTime() + scanMin * 60_000)
                  : (wl?.scheduler?.next_run ? new Date(wl.scheduler.next_run) : null)
                return (
                  <>
                    <span>🤖 <strong>AI signal scan</strong> runs every {scanMin} min during market hours</span>
                    {(lastRunIso || nextRunDerived) && (
                      <span style={{ width: '100%', height: 0, display: 'block', margin: 0, padding: 0 }} />
                    )}
                    {lastRunIso && (
                      <span title={lastRunIso}>
                        🕐 Last scan: {new Date(lastRunIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {lastRunIso && nextRunDerived && (
                      <span style={{ color: 'color-mix(in srgb, var(--dim) 40%, transparent)' }}>·</span>
                    )}
                    {nextRunDerived && (
                      <span title={nextRunDerived.toISOString()}>
                        ⏭ Next scan: {nextRunDerived.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </>
                )
              })()}
            </div>
            <WatchlistCard wl={wl} onWatchlistChange={reloadWatchlist} signals={signals} />
            <SignalsTable
              signals={signals}
              reload={reloadSignals}
              signalOrderMap={Object.fromEntries(
                (dashPaperOrders?.orders ?? [])
                  .filter(o => o.signal_id != null)
                  .map(o => [o.signal_id, o])
              )}
            />
          </div>
        </div>
        <div style={{ display: activeView === 'explorer' ? '' : 'none' }}>
          <ExplorerPage
            key={explorerKey}
            initialResult={explorerState}
            onBack={() => setActiveView('dashboard')}
            modelName={health?.llm_model ?? health?.ollama_model}
            onOpenInExplorer={openExplorer}
          />
        </div>
        {activeView === 'education' && <EducationPage />}
        {activeView === 'backtest' && <BacktestPage wl={wl} usage={usage} />}
        {activeView === 'paper' && (
          <PaperTradingPage
            initialExpandedOrder={tradingExpandOrder}
            onExpandedOrderConsumed={() => setTradingExpandOrder(null)}
          />
        )}
        {activeView === 'settings' && <SettingsPage usage={usage} onUsageRefresh={reloadUsage} onHealthRefresh={reloadHealth} />}
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
