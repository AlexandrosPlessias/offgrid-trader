import { useState, useCallback } from 'react'
import { API, getAuthHeaders } from '../../utils/api'
import SignalCard from './SignalCard'
import InfoTip from '../shared/InfoTip'

const PAGE_SIZE = 30

export default function SignalsTable({ signals, reload, signalOrderMap = {} }) {
  const [open,           setOpen]           = useState(false)
  const [filterSide,     setFilterSide]     = useState('all')
  const [filterConf,     setFilterConf]     = useState(null)
  const [filterMaxPrice, setFilterMaxPrice] = useState(null)
  const [filterTicker,   setFilterTicker]   = useState('')
  const [expanded,       setExpanded]       = useState(null)
  // Pagination — page 1 uses the polled prop data; other pages fetch directly
  const [page,           setPage]           = useState(1)
  const [pageData,       setPageData]       = useState(null)   // fetched page data (pages > 1)
  const [pageLoading,    setPageLoading]    = useState(false)

  const goToPage = useCallback(async (p) => {
    if (p === 1) { setPage(1); setPageData(null); return }
    setPageLoading(true)
    try {
      const res = await fetch(
        `${API}/signals?limit=${PAGE_SIZE}&offset=${(p - 1) * PAGE_SIZE}`,
        { headers: getAuthHeaders() }
      )
      if (res.ok) { setPageData(await res.json()); setPage(p) }
    } finally {
      setPageLoading(false)
    }
  }, [])

  if (!signals) return <div className="card skeleton" style={{ minHeight: 80 }} />

  // Page 1 uses the polled prop; subsequent pages use fetched pageData
  const activeData = page === 1 ? signals : (pageData ?? signals)
  const allRows    = activeData.signals ?? []
  const total      = signals.total ?? (signals.signals ?? []).length   // total from backend
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

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
            {total} stored
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
            onClick={e => { e.stopPropagation(); e.preventDefault(); setPage(1); setPageData(null); reload() }}
            title="Refresh"
          >↻</button>
          <span className="section-chevron">{open ? '▲' : '▼'}</span>
        </div>
      </summary>

      {/* Field guide — sits above the filter bar so it's clearly a legend, not a row */}
      {allRows.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', padding: '10px 16px 6px', fontSize: 11, color: 'var(--dim)', borderBottom: '1px solid var(--border-sub)' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-dim)', marginRight: 4 }}>Card fields:</span>
          {[
            ['Ticker',     'The stock symbol, e.g. AAPL for Apple. Click a row to open it in Explorer.'],
            ['Signal',     "The AI's direction call: LONG means it expects the price to rise, SHORT means it expects a fall."],
            ['Confidence', "A score from 0–100 combining the AI's reasoning and technical indicators. Higher = stronger conviction."],
            ['Risk',       'How dangerous this trade idea is: low / medium / high, based on how much the price swings and how large the position would be.'],
            ['Evidence',   'The number of independent pieces of data (indicators, news, macro) that all point in the same direction.'],
            ['Source',     'What triggered this signal: a regular scheduled scan, a manual Explorer analysis, or an incoming TradingView webhook.'],
            ['Time',       'When this signal was generated.'],
          ].map(([label, tip]) => (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {label} <InfoTip text={tip} />
            </span>
          ))}
        </div>
      )}

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

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
            {/* Prev */}
            <button
              className="btn-ghost"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || pageLoading}
              style={{ fontSize: 13, padding: '3px 10px', borderRadius: 6,
                border: '1px solid var(--border)', opacity: page <= 1 ? 0.35 : 1 }}
            >‹</button>

            {/* Page number pills */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
              .reduce((acc, p, idx, arr) => {
                if (idx > 0 && p - arr[idx - 1] > 1) acc.push('…')
                acc.push(p)
                return acc
              }, [])
              .map((p, idx) =>
                p === '…' ? (
                  <span key={`ellipsis-${idx}`} style={{ color: 'var(--dim)', fontSize: 12, padding: '0 2px' }}>…</span>
                ) : (
                  <button
                    key={p}
                    className="btn-ghost"
                    onClick={() => goToPage(p)}
                    disabled={pageLoading}
                    style={{ fontSize: 12, padding: '3px 9px', borderRadius: 6, minWidth: 32,
                      border: `1px solid ${p === page ? 'var(--accent)' : 'var(--border)'}`,
                      background: p === page ? 'var(--accent)' : 'transparent',
                      color: p === page ? '#fff' : 'var(--text-dim)',
                      fontWeight: p === page ? 700 : 400,
                    }}
                  >{p}</button>
                )
              )
            }

            {/* Next */}
            <button
              className="btn-ghost"
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages || pageLoading}
              style={{ fontSize: 13, padding: '3px 10px', borderRadius: 6,
                border: '1px solid var(--border)', opacity: page >= totalPages ? 0.35 : 1 }}
            >›</button>

            {pageLoading && <span style={{ fontSize: 11, color: 'var(--dim)' }}>Loading…</span>}
            <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 4 }}>
              Page {page} of {totalPages}
            </span>
          </div>
        )}
      </div>
    </details>
  )
}
