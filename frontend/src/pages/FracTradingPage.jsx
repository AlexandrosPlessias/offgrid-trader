import { useState, Fragment } from 'react'
import PriceSlider from '../components/shared/PriceSlider'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import { API, getAuthHeaders } from '../utils/api'
import { usePolling } from '../hooks/usePolling'
import { fmtN } from '../utils/fmt'

const GREEN = '#34d399'
const RED = '#f87171'
const ACCENT = '#a855f7'
const sectLabel = { fontSize: 9, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }
const detailGrid = { display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 2 }

const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`)
const pnlColor = (v) => (v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--dim)')
const fmtQty = (q, notional, entryPrice) => {
  if (q != null) return String(+Number(q).toFixed(6))
  // Derive from notional / entry_price when Alpaca fill was never synced
  if (notional != null && entryPrice != null && Number(entryPrice) > 0)
    return `~${(Number(notional) / Number(entryPrice)).toFixed(6)}`
  return '—'
}

const fmtDuration = (openedAt, closedAt) => {
  if (!openedAt || !closedAt) return '—'
  const ms = new Date(closedAt) - new Date(openedAt)
  if (ms < 0) return '—'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h === 0) return `${m}m`
  if (h < 24) return `${h}h ${m}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const EXIT_META = {
  target:     { icon: '✅', label: 'Take-profit hit',   color: 'var(--green)' },
  stop:       { icon: '🛑', label: 'Stop-loss triggered', color: 'var(--red)'   },
  eod:        { icon: '🌙', label: 'End-of-day close',  color: 'var(--dim)'   },
  manual:     { icon: '✋', label: 'Manual close',       color: 'var(--dim)'   },
  reconciled: { icon: '🔄', label: 'Reconciled',         color: 'var(--dim)'   },
}
const exitMeta = (reason) => EXIT_META[reason] ?? { icon: '—', label: reason ?? '—', color: 'var(--dim)' }

function Tile({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 14px', minWidth: 130, flex: '1 1 130px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
    </div>
  )
}

export default function FracTradingPage() {
  const { data: acctData, reload: reloadAccount, error: acctError } = usePolling('/frac/account', 30_000)
  const { data: readiness, reload: reloadReadiness } = usePolling('/frac/readiness', 60_000)
  const { data: posData, reload: reloadPositions } = usePolling('/frac/positions?limit=200', 30_000)
  const { data: histData, reload: reloadHistory } = usePolling('/frac/history?period=1M&timeframe=1D', 60_000)
  const [closing, setClosing] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [expandedPos, setExpandedPos] = useState(null)
  const [expandedClosed, setExpandedClosed] = useState(null)

  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await Promise.all([reloadAccount(), reloadReadiness(), reloadPositions(), reloadHistory()])
    } finally {
      setRefreshing(false)
    }
  }

  const account = acctData?.account ?? null
  const mode = acctData?.mode ?? readiness?.current_mode ?? posData?.mode ?? 'paper'
  const isLive = mode === 'live'
  const profileName = posData?.profile_name ?? ''
  const positions = posData?.positions ?? []
  const open = positions.filter(p => p.status === 'open')
  const closed = positions.filter(p => p.status === 'closed')

  // ── Chart datasets (all from existing data — no extra API calls) ──────────
  const equitySeries = (histData?.equity ?? [])
    .map((v, i) => ({ i, equity: v }))
    .filter(d => d.equity != null && d.equity > 0)

  const realisedSeries = (() => {
    let cum = 0
    return closed
      .filter(p => p.realized_pnl != null && p.closed_at)
      .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at))
      .map(p => {
        cum += Number(p.realized_pnl)
        return { t: new Date(p.closed_at).toLocaleDateString(), cum: +cum.toFixed(2) }
      })
  })()

  const confSeries = open
    .filter(p => p.signal_confidence != null)
    .map(p => ({ ticker: p.ticker, conf: Number(p.signal_confidence) }))

  const gainLossSeries = open.map(p => {
    const entry = Number(p.entry_price ?? 0)
    const qty = Number(p.qty ?? 0)
    const gain = p.take_profit_price != null && entry ? (Number(p.take_profit_price) - entry) * qty : 0
    const loss = p.stop_price != null && entry ? (entry - Number(p.stop_price)) * qty : 0
    return { ticker: p.ticker, gain: +gain.toFixed(2), loss: -Math.abs(+loss.toFixed(2)) }
  })

  const holdSeries = (() => {
    const buckets = { '<1h': 0, '1-4h': 0, '4-24h': 0, '1-3d': 0, '>3d': 0 }
    closed.forEach(p => {
      if (!p.opened_at || !p.closed_at) return
      const h = (new Date(p.closed_at) - new Date(p.opened_at)) / 3_600_000
      if (h < 1) buckets['<1h']++
      else if (h < 4) buckets['1-4h']++
      else if (h < 24) buckets['4-24h']++
      else if (h < 72) buckets['1-3d']++
      else buckets['>3d']++
    })
    return Object.entries(buckets).map(([bucket, count]) => ({ bucket, count }))
  })()

  const hasCharts = equitySeries.length > 1 || realisedSeries.length || confSeries.length ||
    gainLossSeries.length || closed.length

  const cashout = async (ticker) => {
    if (!window.confirm(`Cash out the fractional ${ticker} position now?`)) return
    setClosing(s => ({ ...s, [ticker]: true }))
    try {
      const res = await fetch(`${API}/frac/positions/${ticker}/close`, {
        method: 'POST', headers: getAuthHeaders(),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(`Cashout failed: ${data.detail ?? res.status}`)
      }
    } finally {
      setClosing(s => ({ ...s, [ticker]: false }))
      reloadPositions(); reloadAccount()
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>🪙 Fractional Trading</h2>
          {profileName && (
            <span style={{
              fontSize: 12, fontWeight: 600, color: 'var(--accent)',
              background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.3)',
              borderRadius: 20, padding: '2px 10px',
            }}>
              {profileName}
            </span>
          )}
          <span style={{
            fontSize: 12, fontWeight: 700, borderRadius: 20, padding: '2px 10px',
            background: isLive ? 'rgba(239,68,68,0.14)' : 'rgba(34,197,94,0.14)',
            border: `1px solid ${isLive ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)'}`,
            color: isLive ? 'var(--red)' : 'var(--green)',
          }}>
            {isLive ? 'LIVE — real money' : 'PAPER'}
          </span>
        </div>
        <button className="btn-ghost" onClick={refreshAll} disabled={refreshing} style={{ fontSize: 12 }}>
          {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {isLive && (
        <div style={{
          fontSize: 13, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)', color: 'var(--red)',
        }}>
          ⚠ This profile is pointed at the live Alpaca host — orders here use real money.
        </div>
      )}

      {acctError && (
        <div style={{ fontSize: 13, color: 'var(--dim)', padding: '10px 12px', border: '1px dashed var(--border)', borderRadius: 8 }}>
          Fractional profile not reachable. Configure its API key, secret and host in
          <strong> Settings → Live / Fractional Trading</strong>, then it will appear here.
        </div>
      )}

      {/* Account tiles */}
      {account && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Tile label="Portfolio value" value={money(account.portfolio_value)} />
          <Tile label="Equity" value={money(account.equity)} />
          <Tile label="Day P&L" value={money(account.day_pnl)} color={pnlColor(account.day_pnl)} />
          <Tile label="Cash" value={money(account.cash)} />
          <Tile label="Buying power" value={money(account.buying_power)} />
        </div>
      )}

      {/* Readiness readout */}
      {readiness && (
        <div className="card">
          <div className="card-title">Paper track record (readiness)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
            <Tile label="Closed trades" value={readiness.trades ?? 0} />
            <Tile label="Win rate" value={`${Math.round((readiness.win_rate ?? 0) * 100)}%`} />
            <Tile label="Realized P&L" value={money(readiness.realized_pnl)} color={pnlColor(readiness.realized_pnl)} />
            <Tile label="Open positions" value={readiness.open_positions ?? 0} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 8 }}>
            When you're happy with this track record, switch the profile host to Live in Settings to trade real money.
          </div>
        </div>
      )}

      {/* Insight charts — all derived from existing data */}
      {hasCharts && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
          {equitySeries.length > 1 && (
            <div className="card">
              <div className="card-title">Portfolio Equity (1 month)</div>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={equitySeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="i" hide />
                  <YAxis tick={{ fontSize: 10 }} width={50} domain={['auto', 'auto']} tickFormatter={v => `$${Math.round(v)}`} />
                  <Tooltip formatter={v => [`$${Number(v).toFixed(2)}`, 'Equity']} labelFormatter={() => ''} />
                  <Area type="monotone" dataKey="equity" stroke={ACCENT} fill={ACCENT} fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {realisedSeries.length > 0 && (
            <div className="card">
              <div className="card-title">Realised P&L (cumulative)</div>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={realisedSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={50} tickFormatter={v => `$${v}`} />
                  <Tooltip formatter={v => [`$${Number(v).toFixed(2)}`, 'Cumulative']} />
                  <Area type="monotone" dataKey="cum" stroke={GREEN} fill={GREEN} fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {confSeries.length > 0 && (
            <div className="card">
              <div className="card-title">Signal Confidence per Order</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={confSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="ticker" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={34} domain={[0, 100]} />
                  <Tooltip formatter={v => [`${v}%`, 'Confidence']} />
                  <Bar dataKey="conf" radius={[3, 3, 0, 0]}>
                    {confSeries.map((d, i) => (
                      <Cell key={i} fill={d.conf >= 85 ? GREEN : d.conf >= 75 ? '#fbbf24' : RED} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {gainLossSeries.length > 0 && (
            <div className="card">
              <div className="card-title">Max Gain / Max Loss per Order (open)</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={gainLossSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="ticker" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={46} tickFormatter={v => `$${v}`} />
                  <Tooltip formatter={(v, n) => [`$${Number(v).toFixed(2)}`, n === 'gain' ? 'Max gain' : 'Max loss']} />
                  <Bar dataKey="gain" fill={GREEN} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="loss" fill={RED} radius={[0, 0, 3, 3]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {closed.length > 0 && (
            <div className="card">
              <div className="card-title">Hold Time (closed orders)</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={holdSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
                  <Tooltip formatter={v => [v, 'Trades']} />
                  <Bar dataKey="count" fill={ACCENT} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Open positions */}
      <div className="card">
        <div className="card-title">
          Open positions <span style={{ color: 'var(--dim)', fontWeight: 400 }}>({open.length})</span>
          {open.length > 0 && <span style={{ fontSize: 10, color: 'var(--dim)', fontWeight: 400, marginLeft: 6 }}>· click a row for details</span>}
        </div>
        {open.length === 0
          ? <div style={{ fontSize: 13, color: 'var(--dim)', padding: '8px 0' }}>No open fractional positions.</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th style={{ width: 32 }}>State</th>
                    <th>Ticker</th><th>Side</th><th>Qty</th><th>Entry</th><th>Current</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Mkt Val</th><th>Unreal. P&L</th><th>P&L %</th>
                    <th>Stop</th><th>Target</th><th style={{ minWidth: 140 }}>Proximity</th><th>Notional</th><th>Conf %</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {open.map(p => {
                    const upnl    = p.unrealized_pl
                    const upnlPct = p.unrealized_plpc != null ? p.unrealized_plpc * 100 : null
                    const isLong  = p.side !== 'sell'
                    const clr     = pnlColor(upnl)
                    const entry   = Number(p.entry_price ?? 0)
                    const qty     = Number(p.qty ?? 0)
                    const stop    = p.stop_price != null ? Number(p.stop_price) : null
                    const target  = p.take_profit_price != null ? Number(p.take_profit_price) : null
                    const maxLoss = stop != null && entry ? (entry - stop) * qty : null
                    const maxGain = target != null && entry ? (target - entry) * qty : null
                    const riskPer = stop != null && entry ? entry - stop : null
                    const rewPer  = target != null && entry ? target - entry : null
                    const isExp   = expandedPos === p.id
                    const isCashing = closing[p.ticker]
                    const stateLabel = isCashing
                      ? { icon: '⚡', text: 'Closing', bg: 'rgba(251,191,36,0.14)', border: 'rgba(251,191,36,0.4)', color: '#fbbf24' }
                      : p.pending_fill
                        ? { icon: '⏳', text: 'Pending fill', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', color: 'var(--dim)' }
                        : { icon: '👁', text: 'Monitoring', bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.35)', color: 'var(--green)' }
                    return (
                      <Fragment key={p.id}>
                        <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedPos(isExp ? null : p.id)}>
                          <td style={{ width: 20, color: 'var(--dim)', fontSize: 11, userSelect: 'none' }}>{isExp ? '▾' : '▸'}</td>
                          <td style={{ width: 32, textAlign: 'center' }}>
                            <span title={stateLabel.text} style={{
                              fontSize: 13, cursor: 'default',
                            }}>
                              {stateLabel.icon}
                            </span>
                          </td>
                          <td><span className="badge-ticker">{p.ticker}</span></td>
                          <td><span className={`badge ${isLong ? 'long' : 'short'}`}>{isLong ? '▲ LONG' : '▼ SHORT'}</span></td>
                          <td>{fmtQty(p.qty, p.notional, p.entry_price)}</td>
                          <td>{money(p.entry_price)}</td>
                          <td>{money(p.current_price)}</td>
                          <td>{money(p.market_value)}</td>
                          <td style={{ color: clr, fontWeight: 600 }}>
                            {upnl != null ? `${upnl >= 0 ? '+' : ''}${money(upnl)}` : '—'}
                          </td>
                          <td style={{ color: clr }}>
                            {upnlPct != null ? `${upnl >= 0 ? '+' : ''}${upnlPct.toFixed(2)}%` : '—'}
                          </td>
                          <td>
                            {stop != null ? (
                              <div style={{ lineHeight: 1.4 }}>
                                <span style={{ color: 'var(--red)' }}>{money(stop)}</span>
                                {maxLoss != null && <div style={{ fontSize: 10, color: 'var(--red)', opacity: 0.8 }}>−{money(Math.abs(maxLoss))}</div>}
                              </div>
                            ) : '—'}
                          </td>
                          <td>
                            {target != null ? (
                              <div style={{ lineHeight: 1.4 }}>
                                <span style={{ color: 'var(--green)' }}>{money(target)}</span>
                                {maxGain != null && <div style={{ fontSize: 10, color: 'var(--green)', opacity: 0.8 }}>+{money(Math.abs(maxGain))}</div>}
                              </div>
                            ) : '—'}
                          </td>
                          <td><PriceSlider stop={stop} target={target} current={p.current_price} /></td>
                          <td>{money(p.notional)}</td>
                          <td>{p.signal_confidence != null ? `${Number(p.signal_confidence).toFixed(0)}%` : '—'}</td>
                          <td onClick={e => e.stopPropagation()}>
                            <button
                              className="btn-ghost"
                              onClick={() => cashout(p.ticker)}
                              disabled={isCashing}
                              style={{ fontSize: 11, fontWeight: 600 }}
                            >
                              {isCashing ? '⏳' : '💵 Cash out'}
                            </button>
                          </td>
                        </tr>
                        {isExp && (
                          <tr style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}>
                            <td colSpan={15} style={{ padding: '10px 18px' }}>
                              <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap', fontSize: 11 }}>
                                {/* Position */}
                                <div style={{ paddingRight: 24 }}>
                                  <div style={sectLabel}>Position</div>
                                  <div style={detailGrid}>
                                    {[
                                      ['Shares', <span style={{ fontWeight: 700 }}>{fmtQty(p.qty, p.notional, p.entry_price)}</span>],
                                      ['Entry', money(p.entry_price)],
                                      ['Current', money(p.current_price)],
                                      ['Mkt Value', money(p.market_value)],
                                      ['Unrealised', <span style={{ color: clr, fontWeight: 700 }}>{upnl != null ? `${upnl >= 0 ? '+' : ''}${money(upnl)}` : '—'}</span>],
                                      ['Notional', money(p.notional)],
                                    ].map(([l, v], idx) => (<Fragment key={idx}><span style={{ color: 'var(--dim)' }}>{l}</span><span>{v}</span></Fragment>))}
                                  </div>
                                </div>
                                {/* Exit plan */}
                                <div style={{ paddingLeft: 24, paddingRight: 24, borderLeft: '1px solid var(--border)' }}>
                                  <div style={sectLabel}>Exit Plan</div>
                                  <div style={detailGrid}>
                                    {[
                                      ['Stop', <span style={{ color: 'var(--red)' }}>{money(stop)}</span>],
                                      ['Target', <span style={{ color: 'var(--green)' }}>{money(target)}</span>],
                                      ['Max Loss', maxLoss != null ? <span style={{ color: 'var(--red)', fontWeight: 700 }}>−{money(Math.abs(maxLoss))}</span> : '—'],
                                      ['Max Gain', maxGain != null ? <span style={{ color: 'var(--green)', fontWeight: 700 }}>+{money(Math.abs(maxGain))}</span> : '—'],
                                      ['R:R', riskPer && rewPer ? <span style={{ fontWeight: 700 }}>{(Math.abs(rewPer) / Math.abs(riskPer)).toFixed(1)}×</span> : '—'],
                                    ].map(([l, v], idx) => (<Fragment key={idx}><span style={{ color: 'var(--dim)' }}>{l}</span><span>{v}</span></Fragment>))}
                                  </div>
                                </div>
                                {/* Signal */}
                                <div style={{ paddingLeft: 24, borderLeft: '1px solid var(--border)' }}>
                                  <div style={sectLabel}>Signal</div>
                                  <div style={detailGrid}>
                                    {[
                                      ['Conf', <span style={{ fontWeight: 700 }}>{p.signal_confidence != null ? `${Number(p.signal_confidence).toFixed(0)}%` : '—'}</span>],
                                      ['Source', p.signal_source ?? '—'],
                                      ['Mode', <span style={{ textTransform: 'uppercase' }}>{p.mode ?? mode}</span>],
                                      ['Opened', p.opened_at ? new Date(p.opened_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'],
                                      ['Order ID', <span style={{ fontSize: 10, color: 'var(--dim)' }}>{p.alpaca_buy_order_id ? String(p.alpaca_buy_order_id).slice(0, 8) : '—'}</span>],
                                    ].map(([l, v], idx) => (<Fragment key={idx}><span style={{ color: 'var(--dim)' }}>{l}</span><span>{v}</span></Fragment>))}
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
          )}
      </div>

      {/* Closed trades */}
      <div className="card">
        <div className="card-title">
          Closed trades <span style={{ color: 'var(--dim)', fontWeight: 400 }}>({closed.length})</span>
          {closed.length > 0 && <span style={{ fontSize: 10, color: 'var(--dim)', fontWeight: 400, marginLeft: 6 }}>· click a row for breakdown</span>}
        </div>
        {closed.length === 0
          ? <div style={{ fontSize: 13, color: 'var(--dim)', padding: '8px 0' }}>No closed fractional trades yet.</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Ticker</th><th>Outcome</th><th>Entry</th><th>Exit</th>
                    <th>Proximity</th><th>P&L</th><th>P&L %</th><th>Held</th><th>Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map(p => {
                    const em = exitMeta(p.exit_reason)
                    const entry = Number(p.entry_price ?? 0)
                    const exit  = Number(p.exit_price  ?? 0)
                    const qty   = Number(p.qty ?? 0)
                    const notional = Number(p.notional ?? 0)
                    const pnl   = p.realized_pnl != null ? Number(p.realized_pnl) : null
                    const pnlPct = entry && exit ? ((exit - entry) / entry * 100) : null
                    const stop   = p.stop_price        != null ? Number(p.stop_price)        : null
                    const target = p.take_profit_price != null ? Number(p.take_profit_price) : null
                    const stopInverted = p.exit_reason === 'stop' && stop != null && entry && stop >= entry
                    const isExp = expandedClosed === p.id
                    return (
                      <Fragment key={p.id}>
                        <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedClosed(isExp ? null : p.id)}>
                          <td style={{ width: 20, color: 'var(--dim)', fontSize: 11, userSelect: 'none' }}>{isExp ? '▾' : '▸'}</td>
                          <td><span className="badge-ticker">{p.ticker}</span></td>
                          <td style={{ color: em.color, fontWeight: 600, whiteSpace: 'nowrap' }}>
                            {em.icon} {em.label}
                            {stopInverted && <span title="Stop was above entry — possible data error" style={{ marginLeft: 5, color: '#fbbf24' }}>⚠</span>}
                          </td>
                          <td>{money(p.entry_price)}</td>
                          <td>{money(p.exit_price)}</td>
                          <td><PriceSlider stop={stop} target={target} current={exit} /></td>
                          <td style={{ color: pnlColor(pnl), fontWeight: 600 }}>
                            {pnl != null ? `${pnl >= 0 ? '+' : ''}${money(pnl)}` : '—'}
                          </td>
                          <td style={{ color: pnlColor(pnlPct) }}>
                            {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '—'}
                          </td>
                          <td style={{ fontSize: 11, color: 'var(--dim)' }}>{fmtDuration(p.opened_at, p.closed_at)}</td>
                          <td style={{ fontSize: 11, color: 'var(--dim)' }}>
                            {p.closed_at ? new Date(p.closed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                        </tr>

                        {isExp && (
                          <tr style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}>
                            <td colSpan={10} style={{ padding: '12px 18px' }}>
                              <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap', fontSize: 11 }}>

                                {/* Performance */}
                                <div style={{ paddingRight: 24, minWidth: 160 }}>
                                  <div style={sectLabel}>Performance</div>
                                  <div style={detailGrid}>
                                    {[
                                      ['Outcome', <span style={{ color: em.color, fontWeight: 700 }}>{em.icon} {em.label}</span>],
                                      ['Entry', money(p.entry_price)],
                                      ['Exit', <span style={{ fontWeight: 700 }}>{money(p.exit_price)}</span>],
                                      ['Move', pnlPct != null ? <span style={{ color: pnlColor(pnlPct), fontWeight: 700 }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</span> : '—'],
                                      ['P&L', pnl != null ? <span style={{ color: pnlColor(pnl), fontWeight: 700 }}>{pnl >= 0 ? '+' : ''}{money(pnl)}</span> : '—'],
                                      ['Deployed', money(p.notional)],
                                      ['Qty', fmtQty(p.qty, p.notional, p.entry_price)],
                                    ].map(([l, v], i) => (<Fragment key={i}><span style={{ color: 'var(--dim)' }}>{l}</span><span>{v}</span></Fragment>))}
                                  </div>
                                </div>

                                {/* Exit plan (was) */}
                                <div style={{ paddingLeft: 24, paddingRight: 24, borderLeft: '1px solid var(--border)', minWidth: 160 }}>
                                  <div style={sectLabel}>Exit Plan (was)</div>
                                  <div style={detailGrid}>
                                    {(() => {
                                      const plannedLoss = stop != null && entry ? Math.abs((entry - stop) * qty) : null
                                      const plannedGain = target != null && entry ? Math.abs((target - entry) * qty) : null
                                      const rr = plannedLoss && plannedGain ? (plannedGain / plannedLoss).toFixed(1) : null
                                      const achievedRR = plannedLoss && pnl != null ? (pnl / plannedLoss).toFixed(2) : null
                                      return [
                                        ['Stop', stop != null
                                          ? <span style={{ color: 'var(--red)' }}>{money(stop)}{stopInverted ? ' ⚠' : ''}</span>
                                          : '—'],
                                        ['Target', <span style={{ color: 'var(--green)' }}>{money(target)}</span>],
                                        ['Max Loss', plannedLoss != null ? <span style={{ color: 'var(--red)' }}>−{money(plannedLoss)}</span> : '—'],
                                        ['Max Gain', plannedGain != null ? <span style={{ color: 'var(--green)' }}>+{money(plannedGain)}</span> : '—'],
                                        ['Planned R:R', rr ? `${rr}×` : '—'],
                                        ['Achieved R:R', achievedRR != null ? <span style={{ color: pnlColor(Number(achievedRR)), fontWeight: 700 }}>{achievedRR}×</span> : '—'],
                                      ].map(([l, v], i) => (<Fragment key={i}><span style={{ color: 'var(--dim)' }}>{l}</span><span>{v}</span></Fragment>))
                                    })()}
                                  </div>
                                </div>

                                {/* Timeline & signal */}
                                <div style={{ paddingLeft: 24, borderLeft: '1px solid var(--border)', minWidth: 160 }}>
                                  <div style={sectLabel}>Timeline & Signal</div>
                                  <div style={detailGrid}>
                                    {[
                                      ['Opened', p.opened_at ? new Date(p.opened_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'],
                                      ['Closed', p.closed_at ? new Date(p.closed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'],
                                      ['Hold time', fmtDuration(p.opened_at, p.closed_at)],
                                      ['Confidence', p.signal_confidence != null ? `${Number(p.signal_confidence).toFixed(0)}%` : '—'],
                                      ['Source', p.signal_source ?? '—'],
                                      ['Mode', <span style={{ textTransform: 'uppercase' }}>{p.mode ?? mode}</span>],
                                    ].map(([l, v], i) => (<Fragment key={i}><span style={{ color: 'var(--dim)' }}>{l}</span><span>{v}</span></Fragment>))}
                                  </div>
                                </div>

                              </div>
                              {stopInverted && (
                                <div style={{
                                  marginTop: 10, padding: '6px 10px', borderRadius: 6, fontSize: 11,
                                  background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.35)', color: '#fbbf24',
                                }}>
                                  ⚠ The stop-loss was set above the entry price — this indicates a signal classification error. The inverted-stop guard has since been deployed to prevent this.
                                </div>
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

      {/* Orders — buy-order record for every position (open + closed) */}
      {positions.length > 0 && (
        <div className="card">
          <div className="card-title">
            Orders <span style={{ color: 'var(--dim)', fontWeight: 400 }}>({positions.length})</span>
            <span style={{ fontSize: 10, color: 'var(--dim)', fontWeight: 400, marginLeft: 6 }}>
              · buy orders placed via the fractional engine
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th><th>Side</th><th>Notional</th><th>Qty (filled)</th>
                  <th>Fill price</th><th>Mode</th><th>Position state</th>
                  <th>Alpaca order ID</th><th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(p => {
                  const isOpen = p.status === 'open'
                  const posState = isOpen
                    ? (p.pending_fill ? '⏳ Pending fill' : '👁 Monitoring')
                    : (() => {
                        const rm = { target: '✅ Target hit', stop: '🛑 Stop hit', eod: '🌙 EoD close', reconciled: '🔄 Reconciled' }
                        return rm[p.exit_reason] ?? '✔ Closed'
                      })()
                  const stateColor = isOpen
                    ? (p.pending_fill ? 'var(--dim)' : 'var(--green)')
                    : (p.exit_reason === 'target' ? 'var(--green)' : p.exit_reason === 'stop' ? 'var(--red)' : 'var(--dim)')
                  return (
                    <tr key={p.id}>
                      <td><span className="badge-ticker">{p.ticker}</span></td>
                      <td><span className="badge long">▲ BUY</span></td>
                      <td>{money(p.notional)}</td>
                      <td style={{ fontSize: 12 }}>{fmtQty(p.qty, p.notional, p.entry_price)}</td>
                      <td>{money(p.entry_price)}</td>
                      <td style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 600 }}>{p.mode ?? mode}</td>
                      <td style={{ fontSize: 12, color: stateColor, fontWeight: 600 }}>{posState}</td>
                      <td style={{ fontSize: 10, color: 'var(--dim)', fontFamily: 'monospace' }}>
                        {p.alpaca_buy_order_id ? String(p.alpaca_buy_order_id).slice(0, 8) + '…' : '—'}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--dim)' }}>
                        {p.opened_at ? new Date(p.opened_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
