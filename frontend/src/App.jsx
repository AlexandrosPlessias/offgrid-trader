import { useState, useEffect, useCallback } from 'react'

const API = '/api'

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

// ─── Header ──────────────────────────────────────────────────────────────────

function Header({ health }) {
  const ok = health?.status === 'ok'
  const open = health?.scheduler?.market_open

  return (
    <header className="header">
      <span className="logo">offgrid-trader</span>
      <div className="header-right">
        {health ? (
          <div className="header-meta">
            <span className={`dot ${ok ? 'green' : 'red'}`} title={ok ? 'backend ok' : 'backend error'} />
            <span className="meta-item">v{health.version}</span>
            <span className="sep">·</span>
            <span className="meta-item">{health.ollama_model}</span>
            <span className="sep">·</span>
            <span className={`market-badge ${open ? 'open' : 'closed'}`}>
              {open ? 'MARKET OPEN' : 'MARKET CLOSED'}
            </span>
          </div>
        ) : (
          <span className="connecting">connecting…</span>
        )}
        <div className="header-tools">
          <a
            href="http://localhost:18889"
            target="_blank"
            rel="noreferrer"
            className="tool-btn"
            title="Aspire — traces & logs"
          >
            Logs
          </a>
          <a
            href="http://localhost:9000"
            target="_blank"
            rel="noreferrer"
            className="tool-btn"
            title="Portainer — container management"
          >
            Portainer
          </a>
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
  const support = key_levels?.support ?? []
  const resistance = key_levels?.resistance ?? []

  return (
    <div className="reasoning-box">
      <button className="reasoning-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="reasoning-toggle-label">LLM Reasoning</span>
        <span className="reasoning-badges-inline">
          {trend && <span className={`rbadge trend-${trend}`}>{trend}</span>}
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
                  S: {support.map((v) => Number(v).toFixed(2)).join(' · ')}
                </span>
              )}
              {resistance.length > 0 && (
                <span className="level-chip resistance">
                  R: {resistance.map((v) => Number(v).toFixed(2)).join(' · ')}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── On-demand analysis ───────────────────────────────────────────────────────

function AnalysisResult({ result }) {
  const { ticker, opportunities = [], actionable = [], errors = [], analysis } = result

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
                <th>Type</th>
                <th>Conf</th>
                <th>Price</th>
                <th>Entry</th>
                <th>Stop</th>
                <th>Target</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {actionable.map((opp, i) => (
                <tr key={i}>
                  <td>
                    <span className={`badge ${opp.type}`}>
                      {opp.type?.toUpperCase() ?? '—'}
                    </span>
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

      <LLMReasoning analysis={analysis} />
    </div>
  )
}

function AnalyzePanel() {
  const [ticker, setTicker] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const run = async () => {
    const t = ticker.trim().toUpperCase()
    if (!t) return
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch(`${API}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t, send_alerts: false }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? `HTTP ${res.status}`)
      }
      setResult(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="card analyze-card">
      <div className="card-title">On-Demand Analysis</div>
      <div className="analyze-row">
        <input
          className="ticker-input"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="Ticker (e.g. NVDA)"
          maxLength={10}
          disabled={loading}
        />
        <button
          className="btn-primary"
          onClick={run}
          disabled={loading || !ticker.trim()}
        >
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>
      {error && <div className="error-msg">{error}</div>}
      {result && <AnalysisResult result={result} />}
    </section>
  )
}

// ─── Recent signals ───────────────────────────────────────────────────────────

function fmt(v) {
  return v != null ? Number(v).toFixed(2) : '—'
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function SignalDetail({ signal, onClose }) {
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`${API}/analysis/${signal.ticker}?limit=5`)
      .then((r) => r.json())
      .then((data) => {
        const history = data.history ?? []
        // Pick the analysis closest in time to the signal
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

  const onRowClick = (r) => {
    setSelected((prev) => (prev?.id === r.id ? null : r))
  }

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
                <th>Time</th>
                <th>Ticker</th>
                <th>Type</th>
                <th>Conf</th>
                <th>Price</th>
                <th>Entry</th>
                <th>Stop</th>
                <th>Target</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`clickable-row${selected?.id === r.id ? ' row-selected' : ''}`}
                  onClick={() => onRowClick(r)}
                >
                  <td className="text-dim ts">{fmtTime(r.created_at)}</td>
                  <td><strong>{r.ticker}</strong></td>
                  <td><span className={`badge ${r.type}`}>{r.type?.toUpperCase() ?? '—'}</span></td>
                  <td>{(r.confidence ?? 0).toFixed(0)}%</td>
                  <td>{fmt(r.price)}</td>
                  <td>{fmt(r.entry)}</td>
                  <td>{fmt(r.stop)}</td>
                  <td>{fmt(r.target)}</td>
                  <td className="text-dim source-cell">{r.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <SignalDetail signal={selected} onClose={() => setSelected(null)} />
      )}
    </section>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const { data: health } = usePolling('/health', 30_000)
  const { data: wl, reload: reloadWatchlist } = usePolling('/watchlist', 60_000)
  const { data: signals, reload: reloadSignals } = usePolling('/signals?limit=30', 60_000)

  return (
    <div className="app">
      <Header health={health} />
      <main className="main">
        <div className="top-grid">
          <WatchlistCard wl={wl} onWatchlistChange={reloadWatchlist} />
          <AnalyzePanel />
        </div>
        <SignalsTable signals={signals} reload={reloadSignals} />
      </main>
      <footer className="footer">Not financial advice. Generated locally.</footer>
    </div>
  )
}
