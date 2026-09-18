import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { API, getAuthHeaders } from '../utils/api'

const deleteReport = async (id) => {
  const r = await fetch(`${API}/reports/${id}`, { method: 'DELETE', headers: getAuthHeaders() })
  if (!r.ok) throw new Error(`Delete failed (${r.status})`)
}

// ── Report-type chip colours (dark-theme-friendly, mirrors Activity chips) ────
const TYPE_STYLE = {
  eod:    { bg: '#12324d', color: '#5cc8ff', label: 'EoD' },
  weekly: { bg: '#2a1a3d', color: '#c98cff', label: 'Weekly' },
  daily:  { bg: '#0f3538', color: '#4fd0d8', label: 'Daily' },
}

const fmtDateTime = (iso) => {
  if (!iso) return ''
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function TypeChip({ type }) {
  const s = TYPE_STYLE[type] || { bg: 'var(--border)', color: 'var(--dim)', label: type }
  return (
    <span style={{
      background: s.bg, color: s.color, borderRadius: 5, padding: '1px 8px',
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{s.label}</span>
  )
}

export default function ReportsPage() {
  // Poll the persisted report history; each record carries both bodies.
  const { data, error, reload } = usePolling('/reports?limit=50', 15000)
  const reports = data?.reports ?? []

  const [selectedId, setSelectedId] = useState(null)
  const [version,    setVersion]    = useState('full')  // 'full' | 'notification'
  const [busy,       setBusy]       = useState(null)     // 'eod' | 'weekly' | null
  const [triggerErr, setTriggerErr] = useState('')
  const [deletingId, setDeletingId] = useState(null)

  // Default selection = most recent report; otherwise the user's pick.
  const selected = reports.find(r => r.id === selectedId) ?? reports[0] ?? null

  const trigger = async (kind) => {
    setBusy(kind); setTriggerErr('')
    const path = kind === 'weekly' ? '/reports/llm-summary?period=weekly' : '/reports/eod'
    try {
      const r = await fetch(`${API}${path}`, { headers: getAuthHeaders() })
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || `Failed (${r.status})`)
      await reload()
      if (d.id) setSelectedId(d.id)   // jump to the freshly-generated report
    } catch (e) {
      setTriggerErr(e.message || 'Generation failed')
      setTimeout(() => setTriggerErr(''), 5000)
    } finally {
      setBusy(null)
    }
  }

  const body = selected ? (version === 'full' ? selected.full_body : selected.notification_body) : ''

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* ── Header: title + manual triggers ─────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>📑 Reports</h1>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>
          {reports.length} report{reports.length === 1 ? '' : 's'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {triggerErr && <span className="settings-err" style={{ fontSize: 12 }}>✗ {triggerErr}</span>}
          <button className="btn-secondary btn-sm" onClick={() => trigger('eod')} disabled={busy !== null}>
            {busy === 'eod' ? '⏳ Generating…' : '⟳ Generate EoD'}
          </button>
          <button className="btn-secondary btn-sm" onClick={() => trigger('weekly')} disabled={busy !== null}>
            {busy === 'weekly' ? '⏳ Generating…' : '⟳ Generate Weekly'}
          </button>
        </div>
      </div>

      {error && <p className="settings-err">Could not load reports.</p>}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── History list ──────────────────────────────────────────────────── */}
        <div style={{ flex: '0 0 260px', minWidth: 220 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                        letterSpacing: '0.08em', marginBottom: 8 }}>History</div>
          {reports.length === 0 && (
            <p className="text-dim" style={{ fontSize: 13 }}>
              No reports yet — generate one above.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {reports.map(r => {
              const active = selected && r.id === selected.id
              const isDeleting = deletingId === r.id
              return (
                <div
                  key={r.id}
                  style={{
                    borderRadius: 8,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--bg-elev, rgba(255,255,255,.04))' : 'transparent',
                  }}
                >
                  <button
                    onClick={() => setSelectedId(r.id)}
                    style={{
                      width: '100%', textAlign: 'left', cursor: 'pointer',
                      background: 'transparent', border: 'none',
                      padding: '8px 10px 6px', display: 'flex', flexDirection: 'column', gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <TypeChip type={r.type} />
                      <span style={{ fontSize: 11, color: 'var(--text)', opacity: 0.7 }}>{r.report_date}</span>
                      {!r.llm && <span title="AI analysis was unavailable" style={{ fontSize: 11 }}>⚠️</span>}
                    </div>
                    <span style={{ fontSize: 12, lineHeight: 1.35, color: 'var(--text)' }}>
                      {r.headline || '(no headline)'}
                    </span>
                  </button>
                  <div style={{ padding: '0 6px 6px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      title="Delete report"
                      disabled={isDeleting}
                      onClick={async (e) => {
                        e.stopPropagation()
                        setDeletingId(r.id)
                        try {
                          await deleteReport(r.id)
                          if (selectedId === r.id) setSelectedId(null)
                          await reload()
                        } catch { /* ignore */ }
                        finally { setDeletingId(null) }
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 11, color: 'var(--dim)', padding: '2px 6px', borderRadius: 4,
                        opacity: isDeleting ? 0.4 : 0.6,
                      }}
                    >
                      {isDeleting ? '…' : '🗑'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Viewer ────────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 300 }}>
          {selected ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <TypeChip type={selected.type} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{selected.headline}</span>
                <span style={{ fontSize: 11, color: 'var(--dim)' }}>{fmtDateTime(selected.created_at)}</span>
                {selected.model && (
                  <span
                    title="LLM model that generated this report"
                    style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
                      background: '#1e2130', color: '#9ba8c9', letterSpacing: '0.03em',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }}
                  >🧠 {selected.model}</span>
                )}
                {/* version toggle */}
                <div style={{ marginLeft: 'auto', display: 'inline-flex', border: '1px solid var(--border)',
                              borderRadius: 7, overflow: 'hidden' }}>
                  {['full', 'notification'].map(v => (
                    <button
                      key={v}
                      onClick={() => setVersion(v)}
                      style={{
                        cursor: 'pointer', border: 'none', fontSize: 12, padding: '4px 12px',
                        background: version === v ? 'var(--accent)' : 'transparent',
                        color: version === v ? '#fff' : 'var(--dim)',
                      }}
                    >{v === 'full' ? 'Full report' : 'Notification'}</button>
                  ))}
                </div>
              </div>
              <pre style={{
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.5,
                background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
                borderRadius: 10, padding: 16, margin: 0, fontFamily: 'inherit',
              }}>{body}</pre>
            </>
          ) : (
            <p className="text-dim">Select a report from the history, or generate one.</p>
          )}
        </div>
      </div>
    </div>
  )
}
