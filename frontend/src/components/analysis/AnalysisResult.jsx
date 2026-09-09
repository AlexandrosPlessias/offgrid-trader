import { useState } from 'react'
import { API, getAuthHeaders } from '../../utils/api'
import MarketCharts from '../charts/MarketCharts'
import LLMReasoning from './LLMReasoning'
import IndicatorTable from './IndicatorTable'

export default function AnalysisResult({ result, onExplore }) {
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
