import { useState, useEffect } from 'react'
import { API, getAuthHeaders } from '../../utils/api'
import { fmtN, fmtTime } from '../../utils/fmt'
import { SOURCE_LABEL } from '../../utils/colors'
import LLMReasoning from '../analysis/LLMReasoning'

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

export default function SignalCard({ r, expanded, onToggle, onDelete, existingOrder = null }) {
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
