import { useState } from 'react'
import { CONF_BAND_COLOR, EVIDENCE_DIR_COLOR, RISK_SEV_COLOR } from '../../utils/colors'

export default function LLMReasoning({ analysis, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!analysis || analysis.error) return null

  const {
    trend, momentum, signals = [], risk_factors = [], key_levels = {},
    // v2 extra fields
    confidence_band, reason_code, data_quality, evidence = [], risks = [], summary,
  } = analysis
  const support    = key_levels?.support    ?? []
  const resistance = key_levels?.resistance ?? []
  const isV2 = !!analysis.schema_version  // true when LLM returned v2 schema

  return (
    <div className="reasoning-box">
      <button className="reasoning-toggle" onClick={() => setOpen(o => !o)}>
        <span className="reasoning-toggle-label">LLM Reasoning</span>
        <span className="reasoning-badges-inline">
          {trend    && <span className={`rbadge trend-${trend}`}>trend: {trend}</span>}
          {momentum && <span className="rbadge momentum">momentum: {momentum}</span>}
          {confidence_band && (
            <span className="rbadge" style={{ color: CONF_BAND_COLOR[confidence_band] || 'var(--dim)', borderColor: CONF_BAND_COLOR[confidence_band] }}>
              confidence: {confidence_band.replace(/_/g, ' ')}
            </span>
          )}
          {reason_code && (
            <span className="rbadge" style={{
              color: reason_code === 'aligned_setup' ? 'var(--green)'
                : reason_code === 'weak_edge' || reason_code === 'conflicting_timeframes' ? 'var(--yellow)'
                : 'var(--dim)',
              fontSize: 10,
            }}>
              {reason_code.replace(/_/g, ' ')}
            </span>
          )}
          {data_quality?.grade && (
            <span className="rbadge" style={{
              color: data_quality.grade === 'good' ? 'var(--green)'
                : data_quality.grade === 'poor' ? 'var(--red)' : 'var(--dim)',
              fontSize: 10,
            }}>
              data: {data_quality.grade}
            </span>
          )}
        </span>
        <span className="reasoning-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="reasoning-body">
          {/* v2: summary line */}
          {summary && (
            <div className="reasoning-section">
              <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text)', margin: 0 }}>{summary}</p>
            </div>
          )}
          {/* v2 evidence with direction/strength; fallback to plain signals list */}
          {(isV2 ? evidence : signals).length > 0 && (
            <div className="reasoning-section">
              <div className="reasoning-label">Evidence</div>
              {isV2 ? (
                <ul className="reasoning-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                  {evidence.map((e, i) => (
                    <li key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, minWidth: 52, paddingTop: 1,
                        color: EVIDENCE_DIR_COLOR[e.direction] || 'var(--dim)' }}>
                        {(e.direction || '').toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13 }}>{e.observation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="reasoning-list">
                  {signals.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              )}
            </div>
          )}
          {/* v2 risks with severity; fallback to plain risk_factors */}
          {(isV2 ? risks : risk_factors).length > 0 && (
            <div className="reasoning-section">
              <div className="reasoning-label risk">Risk Factors</div>
              {isV2 ? (
                <ul className="reasoning-list risk" style={{ listStyle: 'none', paddingLeft: 0 }}>
                  {risks.map((r, i) => (
                    <li key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, minWidth: 52, paddingTop: 1,
                        color: RISK_SEV_COLOR[r.severity] || 'var(--dim)' }}>
                        {(r.severity || '').toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13 }}>{r.observation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="reasoning-list risk">
                  {risk_factors.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
            </div>
          )}
          {(support.length > 0 || resistance.length > 0) && (
            <div className="reasoning-levels">
              {support.length > 0 && (
                <span className="level-chip support">
                  S: {support.map(v => Number(v).toFixed(2)).join(' · ')}
                </span>
              )}
              {resistance.length > 0 && (
                <span className="level-chip resistance">
                  R: {resistance.map(v => Number(v).toFixed(2)).join(' · ')}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
