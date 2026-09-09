import { useState, useEffect, useCallback } from 'react'
import { API, getAuthHeaders } from '../../utils/api'
import { fmtTime } from '../../utils/fmt'

export default function AnalysisHistoryPanel({ onOpenInExplorer, expanded: extExpanded, onToggleExpanded }) {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded    = extExpanded !== undefined ? extExpanded : localExpanded
  const setExpanded = onToggleExpanded ? (v) => onToggleExpanded(typeof v === 'function' ? v(expanded) : v)
                                       : setLocalExpanded
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    fetch(`${API}/analysis?limit=25`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(data => { setHistory(data.history ?? []); setLoading(false) })
      .catch(e  => { setErr(e.message); setLoading(false) })
  }, [])

  // Load data the first time the panel is opened
  useEffect(() => { if (expanded && history === null) load() }, [expanded, history, load])

  const openRow = (row) => {
    // row.opportunities / row.actionable are null for entries recorded before
    // the opportunities columns were added; the stepper shows a friendly
    // "not stored" message in that case rather than "no rule checks fired".
    onOpenInExplorer({
      ticker:        row.ticker,
      analysis:      row.analysis_json,
      market_data:   row.market_snapshot,
      opportunities: row.opportunities,    // null | Opportunity[]
      actionable:    row.actionable ?? [], // null → []
      errors:        [],
      _from_history: true,
      _history_at:   row.created_at,
    })
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this analysis entry?')) return
    await fetch(`${API}/analysis/${id}`, { method: 'DELETE', headers: getAuthHeaders() }).catch(() => {})
    load()
  }

  return (
    <section className="card history-panel">
      <div className="card-title history-panel-header" onClick={() => setExpanded(o => !o)}>
        <span className={`history-panel-chevron${expanded ? ' open' : ''}`}>›</span>
        Analysis History
        {history != null && !expanded && (
          <span className="card-sub">{history.length} saved</span>
        )}
        {expanded && (
          <button
            className="btn-ghost"
            style={{ fontSize: 11, padding: '1px 8px' }}
            onClick={e => { e.stopPropagation(); load() }}
          >↺ Refresh</button>
        )}
      </div>

      {expanded && (
        <>
          {loading && <div className="empty">Loading…</div>}
          {err    && <div className="error-msg">Could not load history: {err}</div>}
          {history && history.length === 0 && (
            <div className="empty">No analyses saved yet — run an analysis in the Explorer above.</div>
          )}
          {history && history.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Trend</th>
                    <th>Confidence</th>
                    <th>Mode</th>
                    <th>Run at</th>
                    <th></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(row => {
                    const aj      = row.analysis_json ?? {}
                    // When LLM is disabled, analysis_json.trend / .opportunity are null;
                    // fall back to the rule-based opportunities stored alongside the record.
                    const bestOpp = (row.opportunities ?? [])
                      .slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
                    const rawTrend = aj.trend
                    const trend    = rawTrend && rawTrend !== 'neutral'
                      ? rawTrend
                      : bestOpp?.type === 'long'  ? 'bullish'
                      : bestOpp?.type === 'short' ? 'bearish'
                      : rawTrend ?? '—'
                    const conf = aj.opportunity?.confidence ?? bestOpp?.confidence
                    return (
                      <tr key={row.id}>
                        <td><span className="badge-ticker">{row.ticker}</span></td>
                        <td><span className={`rbadge trend-${trend}`}>{trend}</span></td>
                        <td>{conf != null && conf > 0 ? `${conf.toFixed(0)}%` : '—'}</td>
                        <td>
                          <span
                            title={row.llm_model ? `Model: ${row.llm_model}` : 'Rule-based engine — LLM was disabled'}
                            style={{
                              fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
                              textTransform: 'uppercase', padding: '2px 5px', borderRadius: 4,
                              background: row.llm_provider
                                ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                                : 'color-mix(in srgb, var(--dim) 10%, transparent)',
                              color: row.llm_provider ? 'var(--accent)' : 'var(--dim)',
                              border: `1px solid ${row.llm_provider ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--dim) 20%, transparent)'}`,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {row.llm_provider ? '🤖 LLM' : '📐 Rules'}
                          </span>
                        </td>
                        <td className="ts">{fmtTime(row.created_at)}</td>
                        <td>
                          <button className="btn-open-history" onClick={() => openRow(row)}>
                            Open in Explorer →
                          </button>
                        </td>
                        <td>
                          <button className="btn-delete" onClick={() => handleDelete(row.id)} title="Delete">×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
