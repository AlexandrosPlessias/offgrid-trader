import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip } from 'recharts'
import { API, getAuthHeaders } from '../utils/api'

export default function TrendingPage({ onViewChange, onOpenSettings, onOpenExplorer }) {
  const [candidates, setCandidates]   = useState([])
  const [runMeta,    setRunMeta]      = useState(null)
  const [loading,    setLoading]      = useState(false)
  const [refreshing, setRefreshing]   = useState(false)
  const [progress,   setProgress]     = useState([])  // {step, message, ts}[]
  const [error,      setError]        = useState(null)
  const [addStatus,       setAddStatus]       = useState({}) // ticker → 'adding'|'done'|'error'
  const [expandedTicker,  setExpandedTicker]  = useState(null) // ticker whose score breakdown is open
  const [history,         setHistory]         = useState([])
  const [historyOpen,     setHistoryOpen]     = useState(false)
  const [expandedRunId,   setExpandedRunId]   = useState(null)   // run being drilled into
  const [runCandidates,   setRunCandidates]   = useState({})     // runId → candidates[]
  const [runLoading,      setRunLoading]      = useState({})     // runId → bool
  const progressEndRef = useRef(null)

  // Auto-scroll the step log to the latest entry
  useEffect(() => { progressEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [progress])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`${API}/discovery/trending`, { headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setRunMeta(d.run)
      setCandidates(d.candidates || [])
    } catch (e) {
      setError(e.message || 'Failed to load trending data')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`${API}/discovery/history?limit=20`, { headers: getAuthHeaders() })
      if (!r.ok) return
      const d = await r.json()
      setHistory(d.runs || [])
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => { load(); loadHistory() }, [load, loadHistory])

  const toggleRunExpand = useCallback(async (runId) => {
    if (expandedRunId === runId) { setExpandedRunId(null); return }
    setExpandedRunId(runId)
    if (runCandidates[runId]) return // already cached
    setRunLoading(prev => ({ ...prev, [runId]: true }))
    try {
      const r = await fetch(`${API}/discovery/history/${runId}/candidates`, { headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setRunCandidates(prev => ({ ...prev, [runId]: d.candidates || [] }))
    } catch {
      setRunCandidates(prev => ({ ...prev, [runId]: [] }))
    } finally {
      setRunLoading(prev => ({ ...prev, [runId]: false }))
    }
  }, [expandedRunId, runCandidates])

  const handleRefresh = async () => {
    setRefreshing(true); setProgress([]); setError(null)
    try {
      const r = await fetch(`${API}/discovery/refresh`, { method: 'POST', headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            const ts = Date.now()
            if (ev.type === 'step')   setProgress(p => [...p, { step: ev.step || 'step', message: ev.message, ts }])
            if (ev.type === 'result') {
              await load(); await loadHistory()
              setProgress(p => [...p, { step: 'result', message: `Done — ${ev.candidate_count} candidate(s) found`, ts }])
            }
            if (ev.type === 'error')  setError(ev.message)
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e) {
      setError(e.message || 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const handleAdd = async (ticker) => {
    setAddStatus(s => ({ ...s, [ticker]: 'adding' }))
    try {
      const r = await fetch(`${API}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ ticker }),
      })
      if (!r.ok) throw new Error(await r.text())
      setAddStatus(s => ({ ...s, [ticker]: 'done' }))
      setCandidates(prev => prev.map(c => c.ticker === ticker ? { ...c, already_in_watchlist: true } : c))
    } catch {
      setAddStatus(s => ({ ...s, [ticker]: 'error' }))
    }
  }

  const fmtPct  = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${parseFloat(v).toFixed(2)}%`
  const fmtVol  = (v) => v == null ? '—' : (v >= 1_000_000 ? `${(v/1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v/1_000).toFixed(0)}K` : String(v))
  const fmtPrice = (v) => v == null ? '—' : `$${parseFloat(v).toFixed(2)}`

  return (
    <div className="page-content" style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>🔥 Trending Tickers</h2>
        <button
          className="btn-primary btn-sm"
          onClick={handleRefresh}
          disabled={refreshing}
          style={{ marginLeft: 'auto' }}
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
        <button
          className="btn-secondary btn-sm"
          onClick={() => onOpenSettings ? onOpenSettings('settings-discovery') : onViewChange('settings')}
          title="Discovery settings"
          style={{ fontSize: 12 }}
        >
          ⚙ Settings
        </button>
      </div>

      {/* Live step monitor */}
      {progress.length > 0 && (
        <div className="discovery-log card" style={{ marginBottom: 16 }}>
          {progress.map((item, i) => {
            const isLast    = i === progress.length - 1
            const isActive  = refreshing && isLast
            const isDone    = item.step === 'result' || item.step === 'done'
            const isWarn    = item.step === 'warn'
            const isError   = item.step === 'error'
            const stepIcon  = { start: '🚀', fetch: '📡', score: '📊', done: '✅', result: '✅', warn: '⚠️', error: '❌' }[item.step] ?? '›'
            const msgColor  = isWarn ? '#f59e0b' : isError ? 'var(--red)' : undefined
            return (
              <div key={i} className={`discovery-log-row${isActive ? ' discovery-log-row--active' : ''}`}>
                <span className="discovery-log-icon">
                  {isActive
                    ? <span className="discovery-spinner" />
                    : <span style={{ opacity: isDone || isWarn || isError ? 1 : 0.55 }}>{stepIcon}</span>}
                </span>
                <span className="discovery-log-msg" style={msgColor ? { color: msgColor } : undefined}>{item.message}</span>
                <span className="discovery-log-ts">{new Date(item.ts).toLocaleTimeString()}</span>
              </div>
            )
          })}
          <div ref={progressEndRef} />
        </div>
      )}

      {error && <p style={{ color: 'var(--red)', marginBottom: 16 }}>✗ {error}</p>}

      {runMeta && candidates.length > 0 && (() => {
        // Source breakdown
        const srcCounts = candidates.reduce((acc, c) => {
          const grp = (c.source || 'unknown').startsWith('alpaca') ? 'Alpaca' : 'yfinance'
          acc[grp] = (acc[grp] || 0) + 1
          return acc
        }, {})
        const srcParts = Object.entries(srcCounts).map(([k, v]) => `${v} from ${k}`)

        // Score stats
        const scores  = candidates.map(c => c.score || 0)
        const topScore = Math.max(...scores).toFixed(0)
        const avgScore = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(0)

        // Top 5 tickers by score
        const top5 = candidates.slice(0, 5).map(c => c.ticker)

        return (
          <div className="card" style={{ marginBottom: 16, padding: '10px 16px', fontSize: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-dim)' }}>
                🕐 {new Date(runMeta.created_at).toLocaleString()}
              </span>
              <span style={{ color: 'var(--text-dim)' }}>
                📦 <strong style={{ color: 'var(--text)' }}>{runMeta.candidate_count}</strong> candidates
              </span>
              <span style={{ color: 'var(--text-dim)' }}>
                🌐 sources: <strong style={{ color: 'var(--text)' }}>{runMeta.sources}</strong>
              </span>
              <span style={{ color: 'var(--text-dim)' }}>
                📥 {srcParts.join(' · ')}
              </span>
              <span style={{ color: 'var(--text-dim)' }}>
                🏆 top score <strong style={{ color: 'var(--green)' }}>{topScore}</strong>
                &nbsp;·&nbsp;avg <strong style={{ color: 'var(--text)' }}>{avgScore}</strong>
              </span>
            </div>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-dim)', marginRight: 2 }}>🔝 Top 5:</span>
              {top5.map(t => (
                <span key={t} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4,
                                       background: 'rgba(255,255,255,.07)', color: 'var(--text)', fontWeight: 600 }}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        )
      })()}

      {!loading && candidates.length === 0 && !error && (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)' }}>
          <p>No discovery data yet.</p>
          <p>Click <strong>↻ Refresh</strong> to run a discovery scan.</p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed', minWidth: 680 }}>
            <colgroup>
              <col style={{ width: '7%'  }} />{/* Ticker  */}
              <col style={{ width: '9%'  }} />{/* Price   */}
              <col style={{ width: '9%'  }} />{/* Change  */}
              <col style={{ width: '9%'  }} />{/* Volume  */}
              <col style={{ width: '11%' }} />{/* Score   */}
              <col />{/* Reasons — takes remaining space */}
              <col style={{ width: '10%' }} />{/* Source  */}
              <col style={{ width: '9%'  }} />{/* Action  */}
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left',   padding: '8px 10px', whiteSpace: 'nowrap' }}>Ticker</th>
                <th style={{ textAlign: 'right',  padding: '8px 10px', whiteSpace: 'nowrap' }}>Price</th>
                <th style={{ textAlign: 'right',  padding: '8px 10px', whiteSpace: 'nowrap' }}>Change</th>
                <th style={{ textAlign: 'right',  padding: '8px 10px', whiteSpace: 'nowrap' }}>Volume</th>
                <th style={{ textAlign: 'right',  padding: '8px 10px', whiteSpace: 'nowrap' }}>Score</th>
                <th style={{ textAlign: 'left',   padding: '8px 10px' }}>Reasons</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', whiteSpace: 'nowrap' }}>Source</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', whiteSpace: 'nowrap' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const pctColor   = (c.percent_change || 0) >= 0 ? 'var(--green)' : 'var(--red)'
                const scoreColor = c.score >= 75 ? 'var(--green)' : c.score >= 50 ? '#f59e0b' : 'var(--text-dim)'
                const adding  = addStatus[c.ticker] === 'adding'
                const added   = c.already_in_watchlist || addStatus[c.ticker] === 'done'
                const cell    = { padding: '8px 10px', verticalAlign: 'middle' }
                const isOpen  = expandedTicker === c.ticker
                const toggleBreakdown = () => setExpandedTicker(t => t === c.ticker ? null : c.ticker)
                const comp    = c.components || {}

                // Score component definitions: [key, label, max, icon]
                const COMP_DEFS = [
                  ['momentum', 'Momentum',  30, '📈'],
                  ['volume',   'Volume',    25, '📊'],
                  ['trend',    'Trend',     25, '📉'],
                  ['rsi_macd', 'RSI/MACD',  20, '🔄'],
                ]

                // Map each reason string to its scoring component by keyword
                const REASON_KEYWORDS = {
                  momentum: ['move', 'Strong move', '%'],
                  volume:   ['volume', 'Volume', 'shares'],
                  trend:    ['EMA', 'uptrend', 'bullish alignment', 'recommendation'],
                  rsi_macd: ['RSI', 'MACD', 'timeframe'],
                }
                const matchReason = (r) => {
                  for (const [key, kws] of Object.entries(REASON_KEYWORDS)) {
                    if (kws.some(kw => r.includes(kw))) return key
                  }
                  return null
                }

                return (
                  <Fragment key={c.ticker}>
                    <tr style={{ borderBottom: isOpen ? 'none' : '1px solid var(--border-subtle, rgba(255,255,255,.06))' }}>
                      <td style={{ ...cell, fontWeight: 700, whiteSpace: 'nowrap' }}>{c.ticker}</td>
                      <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtPrice(c.price)}</td>
                      <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap', color: pctColor, fontWeight: 600 }}>{fmtPct(c.percent_change)}</td>
                      <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{fmtVol(c.volume)}</td>
                      <td
                        style={{ ...cell, textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}
                        onClick={toggleBreakdown}
                        title="Click to see score breakdown"
                      >
                        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                          <span style={{ color: scoreColor, fontWeight: 700, lineHeight: 1 }}>
                            {c.score?.toFixed(0) ?? '—'}
                            <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.6 }}>{isOpen ? '▲' : '▼'}</span>
                          </span>
                          <div style={{ width: 52, height: 4, background: 'var(--border)', borderRadius: 2 }}>
                            <div style={{ width: `${Math.min(c.score || 0, 100)}%`, height: '100%', background: scoreColor, borderRadius: 2, transition: 'width .3s' }} />
                          </div>
                        </div>
                      </td>
                      <td style={{ ...cell, fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={(c.reasons || []).join(' · ') || '—'}>
                        {(c.reasons || []).join(' · ') || '—'}
                      </td>
                      <td style={{ ...cell, textAlign: 'center' }}>
                        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,.08)', color: 'var(--text-dim)', whiteSpace: 'nowrap', display: 'inline-block' }}>
                          {c.source || '—'}
                        </span>
                      </td>
                      <td style={{ ...cell, textAlign: 'center' }}>
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => handleAdd(c.ticker)}
                          disabled={added || adding}
                          style={{ fontSize: 11, padding: '2px 8px', opacity: added ? 0.5 : 1, whiteSpace: 'nowrap' }}
                        >
                          {added ? '✓ Added' : adding ? '…' : '+ Watch'}
                        </button>
                      </td>
                    </tr>

                    {/* ── Score breakdown detail row ──────────────────────── */}
                    {isOpen && (
                      <tr style={{ borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,.06))' }}>
                        <td colSpan={8} style={{ padding: '0 10px 12px 10px', background: 'rgba(255,255,255,.02)' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10 }}>

                            {/* Component bars with inline reason captions */}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px 20px' }}>
                              {COMP_DEFS.map(([key, label, max, icon]) => {
                                const val        = comp[key] ?? 0
                                const pct        = Math.round((val / max) * 100)
                                const barClr     = pct >= 70 ? 'var(--green)' : pct >= 40 ? '#f59e0b' : 'var(--text-dim)'
                                const compReasons = (c.reasons || []).filter(r => matchReason(r) === key)
                                return (
                                  <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    {/* Label row */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)' }}>
                                      <span>{icon} {label}</span>
                                      <span style={{ color: barClr, fontWeight: 600 }}>
                                        {val.toFixed(1)}&thinsp;<span style={{ opacity: 0.45, fontWeight: 400 }}>/ {max}</span>
                                      </span>
                                    </div>
                                    {/* Progress bar */}
                                    <div style={{ height: 5, background: 'var(--border)', borderRadius: 3 }}>
                                      <div style={{ width: `${pct}%`, height: '100%', background: barClr, borderRadius: 3, transition: 'width .4s' }} />
                                    </div>
                                    {/* Per-component reason captions */}
                                    {compReasons.length > 0 && (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                        {compReasons.map((r, i) => (
                                          <span key={i} style={{ fontSize: 10, color: 'var(--text-dim)', opacity: 0.75, display: 'flex', alignItems: 'baseline', gap: 3 }}>
                                            <span style={{ color: barClr, fontSize: 8, flexShrink: 0 }}>✓</span>
                                            {r}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
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
      )}

      {/* Score breakdown chart */}
      {candidates.length > 0 && (() => {
        const data = candidates.slice(0, 15).map(c => ({ name: c.ticker, score: Math.round(c.score || 0) }))
        return (
          <div className="card" style={{ marginTop: 20, padding: '16px 16px 8px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-dim)' }}>Score distribution (top 15)</div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={data} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text-dim)' }} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                  formatter={(v) => [`${v}/100`, 'Score']}
                />
                <Bar dataKey="score" radius={[3,3,0,0]}>
                  {data.map((d, i) => (
                    <Cell key={i} fill={d.score >= 75 ? 'var(--green)' : d.score >= 50 ? '#f59e0b' : 'var(--text-dim)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      })()}

      {/* ── Run history ──────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <button
            onClick={() => setHistoryOpen(o => !o)}
            style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                     display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                     padding: '10px 16px', color: 'var(--text)', fontSize: 13, fontWeight: 600 }}
          >
            <span>🕐 Run history ({history.length})</span>
            <span style={{ opacity: 0.5, fontSize: 11 }}>{historyOpen ? '▲ collapse' : '▼ expand'}</span>
          </button>
          {historyOpen && (
            <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed', minWidth: 480 }}>
                <colgroup>
                  <col style={{ width: '30%' }} />{/* Time */}
                  <col style={{ width: '22%' }} />{/* Sources */}
                  <col style={{ width: '13%' }} />{/* Candidates */}
                  <col style={{ width: '13%' }} />{/* Status */}
                  <col />{/* Error / expand hint */}
                </colgroup>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 12px', whiteSpace: 'nowrap' }}>Time</th>
                    <th style={{ textAlign: 'left', padding: '6px 12px', whiteSpace: 'nowrap' }}>Sources</th>
                    <th style={{ textAlign: 'right', padding: '6px 12px', whiteSpace: 'nowrap' }}>Candidates</th>
                    <th style={{ textAlign: 'center', padding: '6px 12px', whiteSpace: 'nowrap' }}>Status</th>
                    <th style={{ textAlign: 'left', padding: '6px 12px' }}>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(run => {
                    const statusColor  = run.status === 'done' ? 'var(--green)' : run.status === 'error' ? 'var(--red)' : 'var(--text-dim)'
                    const statusIcon   = run.status === 'done' ? '✅' : run.status === 'error' ? '❌' : '⏳'
                    const isExpanded   = expandedRunId === run.id
                    const cands        = runCandidates[run.id] || []
                    const isLoadingRun = runLoading[run.id]

                    // Pretty-print source tag: alpaca_actives → "Alpaca actives", yf_day_gainers → "yf: day gainers"
                    const fmtSource = (s = '') => {
                      if (!s) return '—'
                      if (s.startsWith('alpaca_')) return `🔵 Alpaca ${s.replace('alpaca_', '').replace('_', ' ')}`
                      if (s.startsWith('yf_'))     return `🟡 yf: ${s.replace('yf_', '').replace(/_/g, ' ')}`
                      return s
                    }

                    return (
                      <Fragment key={run.id}>
                        <tr
                          style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border-subtle, rgba(255,255,255,.05))', cursor: run.status === 'done' ? 'pointer' : 'default' }}
                          onClick={() => run.status === 'done' && toggleRunExpand(run.id)}
                          title={run.status === 'done' ? 'Click to see candidates' : undefined}
                        >
                          <td style={{ padding: '6px 12px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                            {new Date(run.created_at).toLocaleString()}
                          </td>
                          <td style={{ padding: '6px 12px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{run.sources}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 600 }}>{run.candidate_count}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'center', color: statusColor, whiteSpace: 'nowrap' }}>
                            {statusIcon} {run.status}
                          </td>
                          <td style={{ padding: '6px 12px', color: 'var(--red)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={run.error || ''}>
                            {run.error
                              ? run.error
                              : run.status === 'done'
                                ? <span style={{ color: 'var(--text-dim)', opacity: 0.45 }}>{isExpanded ? '▲ hide' : '▼ view candidates'}</span>
                                : ''}
                          </td>
                        </tr>

                        {/* ── Expanded candidate sub-table ────────────────── */}
                        {isExpanded && (
                          <tr style={{ borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,.05))' }}>
                            <td colSpan={5} style={{ padding: '0 12px 14px 12px', background: 'rgba(255,255,255,.015)' }}>
                              {isLoadingRun && <div style={{ padding: '10px 0', color: 'var(--text-dim)', fontSize: 11 }}>Loading…</div>}
                              {!isLoadingRun && cands.length === 0 && (
                                <div style={{ padding: '10px 0', color: 'var(--text-dim)', fontSize: 11 }}>No candidates stored for this run.</div>
                              )}
                              {!isLoadingRun && cands.length > 0 && (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 8 }}>
                                  <thead>
                                    <tr style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}>
                                      <th style={{ textAlign: 'left',   padding: '4px 8px' }}>Ticker</th>
                                      <th style={{ textAlign: 'right',  padding: '4px 8px' }}>Score</th>
                                      <th style={{ textAlign: 'left',   padding: '4px 8px' }}>Source</th>
                                      <th style={{ textAlign: 'left',   padding: '4px 8px' }}>Price</th>
                                      <th style={{ textAlign: 'left',   padding: '4px 8px', color: 'var(--text-dim)' }}>Reasons</th>
                                      <th style={{ textAlign: 'center', padding: '4px 8px' }}></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {cands.map((c, ci) => {
                                      const scoreClr  = c.score >= 75 ? 'var(--green)' : c.score >= 50 ? '#f59e0b' : 'var(--text-dim)'
                                      const histAdding = addStatus[c.ticker] === 'adding'
                                      const histAdded  = addStatus[c.ticker] === 'done'
                                      return (
                                        <tr key={ci} style={{ borderBottom: '1px solid rgba(255,255,255,.04)' }}>
                                          <td style={{ padding: '4px 8px', fontWeight: 700 }}>
                                            <button
                                              onClick={() => onOpenExplorer
                                                ? onOpenExplorer({ ticker: c.ticker })
                                                : onViewChange('explorer')}
                                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                                       color: 'var(--text)', fontWeight: 700, fontSize: 11, textDecoration: 'underline dotted' }}
                                              title={`Open ${c.ticker} in Explorer`}
                                            >
                                              {c.ticker}
                                            </button>
                                          </td>
                                          <td style={{ padding: '4px 8px', textAlign: 'right', color: scoreClr, fontWeight: 600 }}>{c.score?.toFixed(0)}</td>
                                          <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                                            <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3,
                                                           background: (c.source || '').startsWith('alpaca') ? 'rgba(59,130,246,.15)' : 'rgba(234,179,8,.12)',
                                                           color:      (c.source || '').startsWith('alpaca') ? '#60a5fa' : '#fbbf24' }}>
                                              {fmtSource(c.source)}
                                            </span>
                                          </td>
                                          <td style={{ padding: '4px 8px', color: 'var(--text-dim)' }}>{c.price ? `$${c.price.toFixed(2)}` : '—'}</td>
                                          <td style={{ padding: '4px 8px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}
                                              title={(c.reasons || []).join(' · ')}>
                                            {(c.reasons || []).join(' · ') || '—'}
                                          </td>
                                          <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                                            <button
                                              className="btn-secondary btn-sm"
                                              onClick={() => handleAdd(c.ticker)}
                                              disabled={histAdded || histAdding}
                                              style={{ fontSize: 10, padding: '1px 6px', opacity: histAdded ? 0.5 : 1, whiteSpace: 'nowrap' }}
                                            >
                                              {histAdded ? '✓' : histAdding ? '…' : '+ Watch'}
                                            </button>
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

    </div>
  )
}
