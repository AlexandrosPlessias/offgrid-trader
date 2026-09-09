import { useState, useEffect, useCallback } from 'react'
import { API, getAuthHeaders } from '../../utils/api'

export default function WatchlistCard({ wl, onWatchlistChange, signals }) {
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
