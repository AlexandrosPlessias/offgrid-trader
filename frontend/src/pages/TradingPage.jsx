import { useState, useEffect } from 'react'
import PaperTradingPage from './PaperTradingPage'
import FracTradingPage from './FracTradingPage'

// Unified Trading page — two tabs:
//   • Order Trading     — whole-share bracket orders on the primary paper account
//   • Fractional Trading — notional buys on the 2nd (frac) Alpaca profile
export default function TradingPage({ initialExpandedOrder, onExpandedOrderConsumed }) {
  const [tab, setTab] = useState('order')

  // A sidebar order deep-link targets the Order Trading tab.
  useEffect(() => { if (initialExpandedOrder) setTab('order') }, [initialExpandedOrder])

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 20px 0' }}>
      <div style={{
        display: 'flex', gap: 4,
        borderBottom: '2px solid var(--border)',
        paddingBottom: 0, marginBottom: 20,
      }}>
        <button
          className={`nav-tab ${tab === 'order' ? 'active' : ''}`}
          onClick={() => setTab('order')}
          style={{
            borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
            borderBottom: tab === 'order' ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: -2,
          }}
        >
          📈 Order Trading
        </button>
        <button
          className={`nav-tab ${tab === 'frac' ? 'active' : ''}`}
          onClick={() => setTab('frac')}
          style={{
            borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
            borderBottom: tab === 'frac' ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: -2,
          }}
        >
          🪙 Fractional Trading
        </button>
      </div>

      {/* Keep both mounted so polling state survives tab switches. */}
      <div style={{ display: tab === 'order' ? '' : 'none' }}>
        <PaperTradingPage
          initialExpandedOrder={initialExpandedOrder}
          onExpandedOrderConsumed={onExpandedOrderConsumed}
        />
      </div>
      <div style={{ display: tab === 'frac' ? '' : 'none' }}>
        <FracTradingPage />
      </div>
    </div>
  )
}
