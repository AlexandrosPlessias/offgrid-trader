import { useState, useEffect, useCallback } from 'react'
import { API, getAuthHeaders } from '../../utils/api'

export default function PaperOrdersPanel({ open, onToggle, onOrderClick }) {
  const [account,      setAccount]      = useState(null)
  const [clock,        setClock]        = useState(null)
  const [orders,       setOrders]       = useState([])
  const [positions,    setPositions]    = useState([])
  const [paperEnabled, setPaperEnabled] = useState(null)   // null = unknown, true/false = known
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState(null)
  const [cancelling,   setCancelling]   = useState({})
  const [recentOpen,   setRecentOpen]   = useState(true)   // collapse/expand recent orders

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ color: '#888', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            Recent Orders {orders.length > 0 && <span style={{ color: '#555' }}>({orders.length})</span>}
          </span>
          <button
            onClick={() => setRecentOpen(v => !v)}
            title={recentOpen ? 'Collapse' : 'Expand'}
            style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
          >
            {recentOpen ? '▲' : '▼'}
          </button>
        </div>
        {orders.length === 0 && !loading && recentOpen && (
          <div style={{ color: '#555', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>No orders yet</div>
        )}
        {recentOpen && orders.slice(0, 20).map((o) => (
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
