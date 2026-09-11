import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import {
  ResponsiveContainer,
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine,
  AreaChart, Area, CartesianGrid,
  PieChart, Pie, Legend,
  LineChart, Line,
} from 'recharts'
import { API, getAuthHeaders } from '../utils/api'
import InfoTip from '../components/shared/InfoTip'

// ─── Paper Trading Page ───────────────────────────────────────────────────────

export default function PaperTradingPage({ initialExpandedOrder = null, onExpandedOrderConsumed }) {
  const [account,   setAccount]   = useState(null)
  const [positions, setPositions] = useState([])
  const [orders,    setOrders]    = useState([])
  const [history,   setHistory]   = useState(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [orderFilter,    setOrderFilter]    = useState('all') // 'all' or any distinct status value
  const [cancelling,     setCancelling]     = useState({})
  const [expandedOrder,  setExpandedOrder]  = useState(null)
  const [expandedPos,    setExpandedPos]    = useState(null) // expanded open-position row
  const [pnlDays,        setPnlDays]        = useState(30)   // P&L chart day window
  const [closingPos,     setClosingPos]     = useState({})   // ticker → bool
  const [closeConfirm,   setCloseConfirm]   = useState(null) // ticker awaiting confirm
  const [closeError,     setCloseError]     = useState({})   // ticker → error msg
  const [closeNote,      setCloseNote]      = useState({})   // ticker → info note (e.g. GTC queued)
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

  const closePosition = async (ticker, qty) => {
    setClosingPos(c => ({ ...c, [ticker]: true }))
    setCloseError(e => { const n = {...e}; delete n[ticker]; return n })
    setCloseNote(e => { const n = {...e}; delete n[ticker]; return n })
    try {
      const res = await fetch(`${API}/paper/positions/${ticker}/close`, { method: 'POST', headers: getAuthHeaders() })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail ?? d.error ?? 'Failed to close position') }
      const d = await res.json().catch(() => ({}))
      setCloseConfirm(null)
      // If the market was closed the backend queues a GTC order — show a note
      if (d.note) setCloseNote(e => ({ ...e, [ticker]: d.note }))
      await load()
    } catch (err) {
      setCloseError(e => ({ ...e, [ticker]: err.message ?? 'Error closing position' }))
    } finally {
      setClosingPos(c => { const n = {...c}; delete n[ticker]; return n })
    }
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
    new: '#fbbf24', pending_new: '#fbbf24', accepted: '#fbbf24', held: '#fbbf24',
  }[s] ?? 'var(--dim)')

  // Derive distinct status values present in the actual orders data.
  // "canceled" is Alpaca's alternate spelling; normalise to "cancelled" for display.
  const normaliseStatus = s => s === 'canceled' ? 'cancelled' : s
  const distinctStatuses = [...new Set(orders.map(o => normaliseStatus(o.status ?? 'unknown')))]
    .sort()  // stable alphabetical order

  const filteredOrders = orders.filter(o =>
    orderFilter === 'all' || normaliseStatus(o.status) === orderFilter
  )

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
        // tip = plain-English tooltip shown on (i) hover
        const tile = (label, value, sub, tip) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              {label}
              {tip && <InfoTip text={tip} />}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div>
            {sub && <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>{sub}</div>}
          </div>
        )
        return (
          <>
            {/* Primary row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {tile('Portfolio Value', fmtMoney(account.portfolio_value ?? account.equity), undefined,
                'The total worth of your account right now — cash you have + the current market value of every stock you hold.')}
              {tile('Equity', fmtMoney(account.equity), undefined,
                'Similar to Portfolio Value. Equity = cash + stock value − any money you borrowed. Think of it as your "net worth" inside this account.')}
              {tile('Day P&L',
                <span style={{ color: dayColor, fontWeight: 700 }}>
                  {dayPnl >= 0 ? '+' : ''}{fmtMoney(dayPnl)}
                </span>,
                <span style={{ color: dayColor }}>{dayPnl >= 0 ? '+' : ''}{parseFloat(dayPnlPct).toFixed(2)}%</span>,
                "How much money you've made or lost today compared to yesterday's closing balance. Green = profit, red = loss.")}
              {tile('Cash', fmtMoney(account.cash), undefined,
                'The uninvested dollars sitting in your account — money that has not been used to buy any stocks yet.')}
              {tile('Buying Power', fmtMoney(account.buying_power),
                account.multiplier ? `${account.multiplier}× margin` : undefined,
                `How much you can spend on new trades right now. ${account.multiplier > 1 ? `Your account uses ${account.multiplier}× margin, so this can be larger than your cash balance — the broker lends you the extra.` : 'This equals your available cash.'}`)}
            </div>
            {/* Secondary row — exposure + margin */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {tile('Long Exposure', fmtMoney(account.long_market_value), 'open long positions',
                'The current market value of all stocks you own (bet they go up). If these stocks drop in price, this number falls.')}
              {tile('Short Exposure', fmtMoney(account.short_market_value), 'open short positions',
                'The current market value of all stocks you have shorted (bet they go down). Shorting means you borrowed shares and sold them, hoping to buy them back cheaper later.')}
              {tile('Maintenance Margin', fmtMoney(account.maintenance_margin), 'min equity required',
                "The minimum equity your account must maintain to avoid a 'margin call'. If your equity falls below this level the broker may automatically close some positions to protect themselves.")}
              {tile('Daytrade Count', account.daytrade_count ?? 0, 'PDT limit: 3 in 5 days',
                'How many times you have opened and closed the same stock on the same day this week. US rules (Pattern Day Trader) limit this to 3 times in a rolling 5-day window unless your account has $25,000+.')}
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

        // ── Win/Loss (only closed orders) ─────────────────────────────────────
        const wins   = closed.filter(o => (o.realized_pnl ?? 0) > 0).length
        const losses = closed.filter(o => (o.realized_pnl ?? 0) <= 0).length
        const pieData = [
          { name: `Wins (${wins})`,     value: wins,   fill: '#34d399' },
          { name: `Losses (${losses})`, value: losses, fill: '#f87171' },
        ].filter(d => d.value > 0)

        // ── Open positions: currently winning vs losing ───────────────────────
        // A position is "winning" when its unrealized P&L is positive right now.
        const posWins   = positions.filter(p => parseFloat(p.unrealized_pl ?? 0) > 0)
        const posLosses = positions.filter(p => parseFloat(p.unrealized_pl ?? 0) <= 0)
        const posPieData = [
          { name: `Winning (${posWins.length})`,   value: posWins.length,   fill: '#34d399' },
          { name: `Losing (${posLosses.length})`,  value: posLosses.length, fill: '#f87171' },
        ].filter(d => d.value > 0)
        const totalUnrealised = positions.reduce((s, p) => s + parseFloat(p.unrealized_pl ?? 0), 0)

        // ── 1. Hold-time histogram (filled orders only) ────────────────────────
        // Bucket = time between order creation and fill
        const HOLD_BUCKETS = [
          { label: '< 1 h',  min: 0,     max: 60 },
          { label: '1–4 h',  min: 60,    max: 240 },
          { label: '4–8 h',  min: 240,   max: 480 },
          { label: '8–24 h', min: 480,   max: 1440 },
          { label: '1–7 d',  min: 1440,  max: 10080 },
          { label: '> 7 d',  min: 10080, max: Infinity },
        ]
        const holdData = HOLD_BUCKETS.map(b => ({
          label: b.label,
          count: orders.filter(o => {
            if (!o.created_at || !o.filled_at) return false
            const mins = (new Date(o.filled_at) - new Date(o.created_at)) / 60_000
            return mins >= b.min && mins < b.max
          }).length,
        })).filter(b => b.count > 0)

        // ── 2. Cumulative P&L by direction (long vs short) ───────────────────
        const closedSorted = [...closed]
          .filter(o => o.filled_at || o.closed_at)
          .sort((a, b) => new Date(a.filled_at || a.closed_at) - new Date(b.filled_at || b.closed_at))
        let _cumLong = 0, _cumShort = 0
        const cumByDir = closedSorted.map((o, i) => {
          const pnl = parseFloat(o.realized_pnl ?? 0)
          if (o.side === 'buy') _cumLong += pnl; else _cumShort += pnl
          return { idx: i + 1, ticker: o.ticker, long: parseFloat(_cumLong.toFixed(2)), short: parseFloat(_cumShort.toFixed(2)) }
        })

        // ── 3. Entry price vs current price per open position ─────────────────
        const posGapData = positions
          .map(p => {
            const entry   = parseFloat(p.avg_entry_price ?? 0)
            const current = parseFloat(p.current_price   ?? 0)
            const gap     = parseFloat((current - entry).toFixed(2))
            const pct     = entry > 0 ? parseFloat(((gap / entry) * 100).toFixed(2)) : 0
            return { ticker: p.symbol ?? p.ticker, entry, current, gap, pct }
          })
          .filter(p => p.entry > 0)
          .sort((a, b) => b.pct - a.pct)

        // Wide card style for Signal Confidence — takes 2× the flex-basis
        const wideCardStyle = { ...cardStyle, flex: '2 1 420px' }

        return (
          <>
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

            {/* Open positions: currently winning vs losing (by unrealised P&L) */}
            {positions.length > 0 && posPieData.length > 0 && (
              <div style={cardStyle}>
                <div style={titleStyle}>
                  Open Positions
                  <span style={{ ...dimStyle, marginLeft: 6 }}>({positions.length} open)</span>
                </div>
                {/* Count summary — winning / losing tickers at a glance */}
                <div style={{ display: 'flex', gap: 16, marginBottom: 6, fontSize: 11, flexWrap: 'wrap' }}>
                  <span style={{ color: '#34d399', fontWeight: 700 }}>
                    {posWins.length} winning
                    {posWins.length > 0 && <span style={{ fontWeight: 400, color: 'var(--dim)', marginLeft: 4 }}>({posWins.map(p => p.symbol ?? p.ticker).join(', ')})</span>}
                  </span>
                  <span style={{ color: '#f87171', fontWeight: 700 }}>
                    {posLosses.length} losing
                    {posLosses.length > 0 && <span style={{ fontWeight: 400, color: 'var(--dim)', marginLeft: 4 }}>({posLosses.map(p => p.symbol ?? p.ticker).join(', ')})</span>}
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <PieChart>
                    <Pie data={posPieData} cx="50%" cy="50%" innerRadius={28} outerRadius={46}
                      dataKey="value" paddingAngle={2}
                      label={({ name, value, percent }) => `${(percent * 100).toFixed(0)}%`}
                      labelLine={{ stroke: 'var(--border)', strokeWidth: 1 }}>
                      {posPieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                    </Pie>
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                    <Tooltip formatter={(v, name) => [v, name]} />
                  </PieChart>
                </ResponsiveContainer>
                {/* Total unrealised P&L */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2, fontSize: 11, fontWeight: 700,
                  color: totalUnrealised >= 0 ? '#34d399' : '#f87171' }}>
                  Total unrealised P&L: {totalUnrealised >= 0 ? '+' : ''}${Math.abs(totalUnrealised).toFixed(2)}
                </div>
              </div>
            )}

            {/* Confidence per order — wide card, taller chart, scrollable */}
            {confData.length > 0 && (
              <div style={wideCardStyle}>
                <div style={titleStyle}>Signal Confidence per Order</div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: Math.max(320, confData.length * 56) }}>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={confData} barCategoryGap="30%" margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
                        <XAxis dataKey="ticker" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} domain={[50, 100]} width={38} />
                        <Tooltip formatter={v => [`${v}%`, 'Confidence']} />
                        <ReferenceLine y={75} stroke="var(--border)" strokeDasharray="3 2" label={{ value: 'floor', position: 'right', fontSize: 9, fill: 'var(--dim)' }} />
                        <Bar dataKey="conf" radius={[4,4,0,0]} maxBarSize={60}>
                          {confData.map((entry, i) => (
                            <Cell key={i} fill={entry.conf >= 85 ? '#34d399' : entry.conf >= 75 ? '#fbbf24' : '#f87171'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div style={dimStyle}>Green ≥ 85% · Amber ≥ 75% (floor) · Red &lt; 75%</div>
              </div>
            )}

            {/* Realised P&L by ticker — scrollable */}
            {pnlByTicker.length > 0 && (
              <div style={cardStyle}>
                <div style={titleStyle}>Realised P&L by Ticker</div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: Math.max(260, pnlByTicker.length * 56) }}>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={pnlByTicker} barCategoryGap="30%" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                        <XAxis dataKey="ticker" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={44} />
                        <Tooltip formatter={v => [`$${v.toFixed(2)}`, 'P&L']} />
                        <ReferenceLine y={0} stroke="var(--border)" />
                        <Bar dataKey="pnl" radius={[3,3,0,0]} maxBarSize={48}>
                          {pnlByTicker.map((entry, i) => <Cell key={i} fill={entry.pnl >= 0 ? '#34d399' : '#f87171'} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
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

            {/* ── Chart 1: Hold-time histogram ─────────────────────────────── */}
            {holdData.length > 0 && (
              <div style={cardStyle}>
                <div style={titleStyle}>Hold Time <span style={dimStyle}>(filled orders)</span></div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={holdData} barCategoryGap="25%" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
                    <Tooltip formatter={v => [v, 'orders']} />
                    <Bar dataKey="count" fill="#60a5fa" radius={[3,3,0,0]} maxBarSize={52} />
                  </BarChart>
                </ResponsiveContainer>
                <div style={dimStyle}>How long between order creation and fill</div>
              </div>
            )}

            {/* ── Chart 2: Cumulative P&L by direction ─────────────────────── */}
            {cumByDir.length > 1 && (
              <div style={cardStyle}>
                <div style={titleStyle}>Cumulative P&L — Long vs Short</div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: Math.max(260, cumByDir.length * 36) }}>
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={cumByDir} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                        <XAxis dataKey="ticker" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={44} />
                        <Tooltip formatter={(v, n) => [`$${v.toFixed(2)}`, n === 'long' ? '▲ Long' : '▼ Short']} />
                        <ReferenceLine y={0} stroke="var(--border)" />
                        <Line type="monotone" dataKey="long"  stroke="#34d399" strokeWidth={2} dot={false} name="long" />
                        <Line type="monotone" dataKey="short" stroke="#f87171" strokeWidth={2} dot={false} name="short" />
                        <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div style={dimStyle}>Running total P&L per direction, trade by trade</div>
              </div>
            )}

            {/* ── Chart 3: Entry price vs current price per position ────────── */}
            {posGapData.length > 0 && (
              <div style={cardStyle}>
                <div style={titleStyle}>Entry vs Current Price <span style={dimStyle}>(open positions)</span></div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: Math.max(260, posGapData.length * 60) }}>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={posGapData} barCategoryGap="30%" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                        <XAxis dataKey="ticker" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false}
                          tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`} width={52} />
                        <Tooltip formatter={(v, n, props) => [
                          `${v > 0 ? '+' : ''}${v.toFixed(2)}% ($${Math.abs(props.payload.gap).toFixed(2)})`,
                          'Move from entry',
                        ]} />
                        <ReferenceLine y={0} stroke="var(--border)" />
                        <Bar dataKey="pct" radius={[3,3,0,0]} maxBarSize={52} name="% from entry">
                          {posGapData.map((entry, i) => (
                            <Cell key={i} fill={entry.pct >= 0 ? '#34d399' : '#f87171'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div style={dimStyle}>Green = above entry price · Red = below entry price</div>
              </div>
            )}

          </div>

          {/* ── Max Gain / Max Loss — full-width row below ─────────────────── */}
          {riskRewardData.length > 0 && (() => {
            const totalGain = riskRewardData.reduce((s, o) => s + o.gain, 0)
            const totalLoss = riskRewardData.reduce((s, o) => s + o.loss, 0)
            const net = totalGain - totalLoss
            return (
              <div style={{ ...cardStyle, flex: '1 1 100%' }}>
                <div style={titleStyle}>Max Gain / Max Loss per Order <span style={dimStyle}>(all open)</span></div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: Math.max(400, riskRewardData.length * 80) }}>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={riskRewardData} barCategoryGap="25%" margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
                        <XAxis dataKey="ticker" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={50} />
                        <Tooltip formatter={(v, n) => [`$${v.toFixed(2)}`, n === 'gain' ? 'Max gain' : 'Max loss']} />
                        <ReferenceLine y={0} stroke="var(--border)" />
                        <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="gain" fill="#34d399" radius={[4,4,0,0]} name="Max gain" maxBarSize={56} />
                        <Bar dataKey="loss" fill="#f87171" radius={[4,4,0,0]} name="Max loss" maxBarSize={56} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4, fontSize: 11 }}>
                  <div style={{ display: 'flex', gap: 20 }}>
                    <span>Total max gain: <strong style={{ color: '#34d399' }}>+${totalGain.toFixed(2)}</strong></span>
                    <span>Total max loss: <strong style={{ color: '#f87171' }}>−${totalLoss.toFixed(2)}</strong></span>
                  </div>
                  <span style={{ fontWeight: 700, color: net >= 0 ? '#34d399' : '#f87171' }}>
                    Net best-case: {net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(2)}
                  </span>
                </div>
              </div>
            )
          })()}
          </>
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
                    <th>Stop</th><th>Target</th><th>Conf %</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => {
                    const ticker   = p.symbol ?? p.ticker
                    const isLong   = parseFloat(p.qty ?? 0) >= 0
                    const side     = isLong ? 'buy' : 'sell'
                    // Find the most-recent matching order for stop/target/signal info
                    const matchOrd = orders.find(o => o.ticker === ticker && o.side === side &&
                      ['new','pending_new','accepted','held','partially_filled'].includes(o.status))
                      ?? orders.find(o => o.ticker === ticker && o.side === side)
                    const isExpPos = expandedPos === i
                    const qty      = Math.abs(parseFloat(p.qty ?? 0))
                    // qty_available = 0 when shares are locked in a pending bracket order's
                    // stop-loss or take-profit leg — cashout is not possible until that order settles
                    const qtyAvail = Math.abs(parseFloat(p.qty_available ?? p.qty ?? 0))
                    const isLocked = qtyAvail <= 0
                    // Also treat a 'new' status match-order as locked (order not yet sent to exchange)
                    const hasPendingNew = matchOrd?.status === 'new'
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
                          {/* Close Position action */}
                          <td onClick={e => e.stopPropagation()} style={{ minWidth: 120 }}>
                            {(isLocked || hasPendingNew) ? (
                              /* Shares locked in a pending bracket/new order — cashout blocked */
                              <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.4 }}>
                                <span title={hasPendingNew
                                  ? 'Order is still being sent to the exchange (NEW). Wait a moment then refresh.'
                                  : 'All shares are reserved in a pending stop-loss or take-profit order. The cashout will be available once those orders settle or are cancelled.'
                                }>
                                  🔒 {hasPendingNew ? 'Order pending…' : 'Shares locked'}
                                </span>
                              </div>
                            ) : closeConfirm === ticker ? (
                              <div style={{ fontSize: 10, lineHeight: 1.4 }}>
                                <div style={{ color: 'var(--text)', marginBottom: 4, fontWeight: 600 }}>
                                  {isLong ? 'Sell' : 'Buy back'}{' '}
                                  {qtyAvail < qty
                                    ? <>{qtyAvail} of {qty} {isLong ? 'shares' : 'short shares'}</>
                                    : <>all {qty} {isLong ? 'shares' : 'short shares'}</>
                                  }{' '}of {ticker} at market? This cannot be undone.
                                  {qtyAvail < qty && (
                                    <div style={{ color: 'var(--dim)', fontWeight: 400, marginTop: 2 }}>
                                      {qty - qtyAvail} share{qty - qtyAvail !== 1 ? 's' : ''} are locked in a pending bracket order.
                                    </div>
                                  )}
                                </div>
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button
                                    onClick={() => closePosition(ticker, qtyAvail)}
                                    disabled={closingPos[ticker]}
                                    style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
                                      background: 'color-mix(in srgb, var(--red) 18%, transparent)',
                                      border: '1px solid color-mix(in srgb, var(--red) 40%, transparent)',
                                      color: 'var(--red)', fontWeight: 700 }}
                                  >
                                    {closingPos[ticker] ? 'Closing…' : 'Confirm'}
                                  </button>
                                  <button
                                    onClick={() => { setCloseConfirm(null); setCloseError(e => { const n={...e}; delete n[ticker]; return n }) }}
                                    disabled={closingPos[ticker]}
                                    style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
                                      background: 'transparent',
                                      border: '1px solid var(--border)',
                                      color: 'var(--text-dim)', fontWeight: 400 }}
                                  >
                                    No
                                  </button>
                                </div>
                                {closeError[ticker] && (
                                  <div style={{ marginTop: 4, color: 'var(--red)', fontSize: 10 }}>{closeError[ticker]}</div>
                                )}
                                {closeNote[ticker] && (
                                  <div style={{ marginTop: 4, color: '#fbbf24', fontSize: 10 }}>⏳ {closeNote[ticker]}</div>
                                )}
                              </div>
                            ) : (
                              <div>
                                <button
                                  onClick={() => setCloseConfirm(ticker)}
                                  style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
                                    background: 'color-mix(in srgb, var(--red) 12%, transparent)',
                                    border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
                                    color: 'var(--red)', fontWeight: 600 }}
                                >
                                  💸 Instant Cashout
                                </button>
                                {closeError[ticker] && (
                                  <div style={{ marginTop: 4, color: 'var(--red)', fontSize: 10 }}>{closeError[ticker]}</div>
                                )}
                                {closeNote[ticker] && (
                                  <div style={{ marginTop: 4, color: '#fbbf24', fontSize: 10 }}>⏳ {closeNote[ticker]}</div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                        {/* Expanded position detail panel */}
                        {isExpPos && matchOrd && (
                          <tr style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}>
                            <td colSpan={13} style={{ padding: '10px 18px' }}>
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
            {['all', ...distinctStatuses].map(f => (
              <button key={f} onClick={() => setOrderFilter(f)}
                style={{
                  fontSize: 10, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
                  textTransform: 'uppercase', letterSpacing: '0.03em',
                  background: orderFilter === f ? 'var(--accent)' : 'transparent',
                  color: orderFilter === f ? '#fff' : (f === 'all' ? 'var(--dim)' : statusColor(f)),
                  border: `1px solid ${orderFilter === f ? 'var(--accent)' : 'var(--border)'}`,
                  fontWeight: orderFilter === f ? 700 : 400,
                }}
              >{f === 'all' ? 'All' : f.replace(/_/g, ' ')}</button>
            ))}
          </div>
        </div>

        {/* ── Order status legend — open by default so users see it without clicking ── */}
        <details className="order-status-legend" open style={{ marginBottom: 12, fontSize: 11 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', userSelect: 'none', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
            ❓ What do these statuses mean?
          </summary>
          <div style={{ marginTop: 8 }}>
            <table style={{ fontSize: 11, borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 130 }} />
                <col style={{ width: 140 }} />
                <col />  {/* description — takes remaining width and wraps */}
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 10px 4px 0', color: 'var(--text-dim)', fontWeight: 600, whiteSpace: 'nowrap' }}>Status badge</th>
                  <th style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--text-dim)', fontWeight: 600, whiteSpace: 'nowrap' }}>Plain-English label</th>
                  <th style={{ textAlign: 'left', padding: '4px 0 4px 10px', color: 'var(--text-dim)', fontWeight: 600, whiteSpace: 'normal' }}>What it means</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['new',             'Just created',       'The order was received by our system but has not been sent to the exchange yet. You may see 0 shares — that is normal, nothing has executed.'],
                  ['pending_new',     'Being sent…',        'The order is on its way to the exchange right now — it left our system but the exchange has not confirmed receipt yet.'],
                  ['accepted / held', 'In the queue',       'The exchange received it and is waiting for the right moment to act.'],
                  ['partially_filled','Half done',          "Some shares were bought/sold, but the rest is still waiting. You'll see two prices — what filled and what you're still hoping for."],
                  ['filled',          'Done ✓',            'All shares bought or sold. The "Filled @" price is what you actually paid or received.'],
                  ['cancelled',       'Cancelled',          'Called off before it could complete. Nothing was bought or sold.'],
                  ['expired',         'Ran out of time',    "Day orders automatically cancel at market close if they weren't filled. Like a shop closing before you reached the till."],
                ].map(([badge, label, meaning]) => (
                  <tr key={badge} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '5px 10px 5px 0', whiteSpace: 'nowrap' }}>
                      <code style={{ fontSize: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1px 5px', color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>
                        {badge.replace(/_/g, ' ')}
                      </code>
                    </td>
                    <td style={{ padding: '5px 10px', color: 'var(--text)', fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</td>
                    {/* whiteSpace: normal overrides the global tbody td { white-space: nowrap } rule */}
                    <td style={{ padding: '5px 0 5px 10px', color: 'var(--text-dim)', lineHeight: 1.5, whiteSpace: 'normal', wordBreak: 'break-word' }}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

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
                          <span style={{ fontSize: 10, fontWeight: 700, color: statusColor(o.status), display: 'flex', flexDirection: 'column', lineHeight: 1.3, letterSpacing: '0.04em' }}>
                            {(o.status ?? '—').replace(/_/g,' ').toUpperCase().split(' ').map((w, i) => <span key={i}>{w}</span>)}
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
