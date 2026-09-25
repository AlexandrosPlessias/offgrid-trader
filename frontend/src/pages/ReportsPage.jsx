import { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { usePolling } from '../hooks/usePolling'
import { API, getAuthHeaders } from '../utils/api'

const deleteReport = async (id) => {
  const r = await fetch(`${API}/reports/${id}`, { method: 'DELETE', headers: getAuthHeaders() })
  if (!r.ok) throw new Error(`Delete failed (${r.status})`)
}

// ── Report-type chip colours ───────────────────────────────────────────────────
const TYPE_STYLE = {
  eod_orders:    { bg: '#12324d', color: '#5cc8ff',  label: 'EoD Orders' },
  weekly_orders: { bg: '#2a1a3d', color: '#c98cff',  label: 'Wkly Orders' },
  eod_frac:      { bg: '#0f3538', color: '#4fd0d8',  label: 'EoD Frac' },
  weekly_frac:   { bg: '#12321a', color: '#7acc8c',  label: 'Wkly Frac' },
  // legacy types (kept for old records)
  eod:           { bg: '#12324d', color: '#5cc8ff',  label: 'EoD' },
  weekly:        { bg: '#2a1a3d', color: '#c98cff',  label: 'Weekly' },
  daily:         { bg: '#0f3538', color: '#4fd0d8',  label: 'Daily' },
}

const ORDERS_TYPES = new Set(['eod_orders', 'weekly_orders', 'eod', 'daily', 'weekly'])
const FRAC_TYPES   = new Set(['eod_frac', 'weekly_frac'])

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
      whiteSpace: 'nowrap',
    }}>{s.label}</span>
  )
}

function BlockedBanner({ report }) {
  const ctx = report?.context_json ? (() => { try { return JSON.parse(report.context_json) } catch { return null } })() : null
  const blocked = ctx?.blocked_events
  if (!blocked) return null
  const hits = (blocked.position_cap_hits || 0) + (blocked.budget_cap_hits || 0)
  if (!hits) return null
  const parts = []
  if (blocked.position_cap_hits) parts.push(`${blocked.position_cap_hits} position-cap block${blocked.position_cap_hits > 1 ? 's' : ''}`)
  if (blocked.budget_cap_hits)   parts.push(`${blocked.budget_cap_hits} budget-cap block${blocked.budget_cap_hits > 1 ? 's' : ''}`)
  return (
    <div style={{
      background: '#2d2400', border: '1px solid #6b5200', borderRadius: 8,
      padding: '8px 12px', marginBottom: 10, fontSize: 12, color: '#f0c040',
    }}>
      ⚠️ {parts.join(' · ')} — see tuning suggestions below
    </div>
  )
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

const CHART_GREEN = '#4ade80'
const CHART_RED   = '#f87171'
const CHART_BLUE  = '#60a5fa'
const CHART_DIM   = 'rgba(255,255,255,.12)'

function StatPill({ label, value, color }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      background: 'var(--bg-elev, rgba(255,255,255,.04))', border: '1px solid var(--border)',
      borderRadius: 10, padding: '8px 14px', minWidth: 90,
    }}>
      <span style={{ fontSize: 17, fontWeight: 700, color: color || 'var(--text)' }}>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase',
                     letterSpacing: '0.06em', marginTop: 2 }}>{label}</span>
    </div>
  )
}

function TopMoversChart({ data, title }) {
  if (!data?.length) return null
  const sorted = [...data]
    .filter(d => d.pnl != null)
    .sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
  if (!sorted.length) return null
  const chartData = sorted.map(d => ({
    name: d.ticker,
    pnl: parseFloat((d.pnl || 0).toFixed(2)),
  }))
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase',
                    letterSpacing: '0.07em', marginBottom: 8, fontWeight: 700 }}>{title}</div>
      <ResponsiveContainer width="100%" height={Math.max(120, chartData.length * 34)}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 24, top: 0, bottom: 0 }}>
          <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--dim)' }} tickFormatter={v => `$${v}`} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" width={56} tick={{ fontSize: 11, fill: 'var(--text)' }} axisLine={false} tickLine={false} />
          <Tooltip
            formatter={v => [`$${v}`, 'P&L']}
            contentStyle={{ background: '#1a1d2e', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12 }}
            cursor={{ fill: CHART_DIM }}
          />
          <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.pnl >= 0 ? CHART_GREEN : CHART_RED} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function WinRatePie({ wins, losses, label }) {
  if (wins == null && losses == null) return null
  const total = (wins || 0) + (losses || 0)
  if (!total) return null
  const data = [
    { name: 'Wins', value: wins || 0, fill: CHART_GREEN },
    { name: 'Losses', value: losses || 0, fill: CHART_RED },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase',
                    letterSpacing: '0.07em', marginBottom: 4, fontWeight: 700 }}>{label}</div>
      <PieChart width={110} height={110}>
        <Pie data={data} cx={55} cy={55} innerRadius={28} outerRadius={48}
             dataKey="value" paddingAngle={2} startAngle={90} endAngle={-270}>
          {data.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
        </Pie>
        <Tooltip
          formatter={(v, name) => [v, name]}
          contentStyle={{ background: '#1a1d2e', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12 }}
        />
      </PieChart>
      <div style={{ fontSize: 12, fontWeight: 700, marginTop: -4 }}>
        <span style={{ color: CHART_GREEN }}>{wins || 0}W</span>
        <span style={{ color: 'var(--dim)', margin: '0 4px' }}>/</span>
        <span style={{ color: CHART_RED }}>{losses || 0}L</span>
      </div>
    </div>
  )
}

function SignalConfidenceChart({ signals }) {
  if (!signals?.length) return null
  const buckets = { '≥90%': 0, '75-89%': 0, '60-74%': 0, '<60%': 0 }
  signals.forEach(s => {
    const c = (s.confidence || 0) * 100
    if (c >= 90) buckets['≥90%']++
    else if (c >= 75) buckets['75-89%']++
    else if (c >= 60) buckets['60-74%']++
    else buckets['<60%']++
  })
  const data = Object.entries(buckets).map(([name, value]) => ({ name, value }))
  if (data.every(d => d.value === 0)) return null
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase',
                    letterSpacing: '0.07em', marginBottom: 8, fontWeight: 700 }}>Signal Confidence</div>
      <ResponsiveContainer width="100%" height={90}>
        <BarChart data={data} margin={{ left: -10, right: 8, top: 0, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--dim)' }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: 'var(--dim)' }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ background: '#1a1d2e', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12 }}
            cursor={{ fill: CHART_DIM }}
          />
          <Bar dataKey="value" fill={CHART_BLUE} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function ReportCharts({ report }) {
  const ctx = (() => {
    try { return report.context_json ? JSON.parse(report.context_json) : null } catch { return null }
  })()
  if (!ctx) return null

  const eco  = ctx.bracket_economics  || {}
  const feco = ctx.frac_economics     || {}
  const isFrac    = FRAC_TYPES.has(report.type)
  const isOrders  = ORDERS_TYPES.has(report.type)

  const totalPnl    = ((eco.total_pnl || 0) + (feco.total_pnl || 0))
  const closedTotal = (eco.closed_trades || 0) + (feco.closed_trades || 0)
  const winsTotal   = (eco.wins || 0) + (feco.wins || 0)
  const pnlColor    = totalPnl >= 0 ? CHART_GREEN : CHART_RED
  const pnlStr      = `${totalPnl >= 0 ? '+' : ''}$${Math.abs(totalPnl).toFixed(2)}`

  const bracketMovers = ctx.top_bracket_movers || []
  const fracMovers    = ctx.top_frac_movers    || []
  const allMovers     = [...bracketMovers, ...fracMovers]

  return (
    <div style={{ marginBottom: 16 }}>
      {/* ── Summary pills ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {closedTotal > 0 && (
          <StatPill label="Total P&L" value={pnlStr} color={pnlColor} />
        )}
        {closedTotal > 0 && (
          <StatPill
            label="Win Rate"
            value={`${Math.round(winsTotal / closedTotal * 100)}%`}
            color={winsTotal / closedTotal >= 0.5 ? CHART_GREEN : CHART_RED}
          />
        )}
        {closedTotal > 0 && <StatPill label="Closed" value={closedTotal} />}
        {ctx.signals_count > 0 && <StatPill label="Signals" value={ctx.signals_count} color={CHART_BLUE} />}
      </div>

      {/* ── Charts row ─────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {/* Win/Loss pie — show for orders when there are closed trades */}
        {isOrders && closedTotal > 0 && (
          <div style={{ background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
                        borderRadius: 10, padding: '12px 14px' }}>
            <WinRatePie wins={eco.wins} losses={(eco.closed_trades || 0) - (eco.wins || 0)} label="Bracket W/L" />
          </div>
        )}
        {isFrac && closedTotal > 0 && (
          <div style={{ background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
                        borderRadius: 10, padding: '12px 14px' }}>
            <WinRatePie wins={feco.wins} losses={(feco.closed_trades || 0) - (feco.wins || 0)} label="Frac W/L" />
          </div>
        )}

        {/* Top movers P&L bars */}
        {allMovers.length > 0 && (
          <div style={{ background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
                        borderRadius: 10, padding: '12px 14px', gridColumn: allMovers.length > 3 ? 'span 2' : undefined }}>
            <TopMoversChart data={allMovers} title="Top Movers · P&L" />
          </div>
        )}

        {/* Signal confidence histogram */}
        {ctx.signals?.length > 0 && (
          <div style={{ background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
                        borderRadius: 10, padding: '12px 14px' }}>
            <SignalConfidenceChart signals={ctx.signals} />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Report viewer ─────────────────────────────────────────────────────────────

function ReportViewer({ report }) {
  const [version,   setVersion]   = useState('full')
  const [copyState, setCopyState] = useState(null)  // null | 'copying' | 'ok'

  if (!report) return <p className="text-dim">Select a report from the history, or generate one.</p>

  const body = version === 'full' ? (report.full_body || '') : (report.notification_body || '')

  const copyToClipboard = async () => {
    setCopyState('copying')
    try {
      await navigator.clipboard.writeText(body)
      setCopyState('ok')
      setTimeout(() => setCopyState(null), 2000)
    } catch {
      setCopyState(null)
    }
  }

  const downloadReport = () => {
    const slug = (report.report_date || fmtDateTime(report.created_at)).replace(/[/:, ]/g, '-')
    const filename = `report-${report.type}-${slug}.txt`
    const blob = new Blob([body], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {/* ── Report header ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <TypeChip type={report.type} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{report.headline}</span>
        <span style={{ fontSize: 11, color: 'var(--dim)' }}>{fmtDateTime(report.created_at)}</span>
        {report.model && (
          <span
            title="LLM model that generated this report"
            style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
              background: '#1e2130', color: '#9ba8c9', letterSpacing: '0.03em',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >🧠 {report.model}</span>
        )}
      </div>

      {/* ── Toolbar: version toggle + copy + download ──────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn-secondary btn-sm" onClick={copyToClipboard} disabled={copyState === 'copying'}>
            {copyState === 'ok' ? 'Copied ✓' : 'Copy'}
          </button>
          <button className="btn-secondary btn-sm" onClick={downloadReport} title="Download report as .txt">
            ↓ Download
          </button>
        </div>
      </div>

      <BlockedBanner report={report} />

      {/* ── Charts (full view only) ────────────────────────────────────────── */}
      {version === 'full' && <ReportCharts report={report} />}

      {/* ── Report body ───────────────────────────────────────────────────── */}
      <pre style={{
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.6,
        background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
        borderRadius: 10, padding: 16, margin: 0, fontFamily: 'inherit',
      }}>{body || '(empty)'}</pre>
    </>
  )
}

function HistoryList({ reports, selectedId, onSelect, onDelete, deletingId }) {
  if (reports.length === 0) return (
    <p className="text-dim" style={{ fontSize: 13 }}>No reports yet — generate one above.</p>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {reports.map(r => {
        const active = r.id === selectedId
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
              onClick={() => onSelect(r.id)}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer',
                background: 'transparent', border: 'none',
                padding: '8px 10px 6px', display: 'flex', flexDirection: 'column', gap: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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
                  try {
                    await onDelete(r.id)
                  } catch { /* ignore */ }
                }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 11, color: 'var(--dim)', padding: '2px 6px', borderRadius: 4,
                  opacity: isDeleting ? 0.4 : 0.6,
                }}
              >{isDeleting ? '…' : '🗑'}</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TabPane({ reports, modeTypes, trigger, busyKey, triggerErr, selectedId, setSelectedId, deletingId, onDelete }) {
  const filtered = reports.filter(r => modeTypes.has(r.type))
  const selected = filtered.find(r => r.id === selectedId) ?? filtered[0] ?? null

  const [eodKey, weeklyKey] = busyKey  // e.g. ['eod_frac', 'weekly_frac']
  const isFrac = eodKey.includes('frac')
  const modeName = isFrac ? 'Frac' : 'Orders'

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* ── History sidebar ─────────────────────────────────────────────────── */}
      <div style={{ flex: '0 0 260px', minWidth: 220 }}>
        {/* Inline generate buttons per tab */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {triggerErr && <span className="settings-err" style={{ fontSize: 12, width: '100%' }}>✗ {triggerErr}</span>}
          <button className="btn-secondary btn-sm" onClick={() => trigger(eodKey)} disabled={trigger.busy !== null}>
            {trigger.busy === eodKey ? `⏳ ${trigger.step ?? 'Generating…'}` : `⟳ EoD ${modeName}`}
          </button>
          <button className="btn-secondary btn-sm" onClick={() => trigger(weeklyKey)} disabled={trigger.busy !== null}>
            {trigger.busy === weeklyKey ? `⏳ ${trigger.step ?? 'Generating…'}` : `⟳ Weekly ${modeName}`}
          </button>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.08em', marginBottom: 8 }}>
          History · {filtered.length}
        </div>
        <HistoryList
          reports={filtered}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          onDelete={onDelete}
          deletingId={deletingId}
        />
      </div>

      {/* ── Viewer ──────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 300 }}>
        <ReportViewer report={selected} />
      </div>
    </div>
  )
}

export default function ReportsPage() {
  const { data, error, reload } = usePolling('/reports?limit=100', 15000)
  const reports = data?.reports ?? []

  const [tab,        setTab]        = useState('orders')
  const [selectedId, setSelectedId] = useState(null)
  const [busy,       setBusy]       = useState(null)
  const [triggerErr, setTriggerErr] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const [genStep,    setGenStep]    = useState(null)   // null | 'data' | 'llm' | 'saving'

  const GEN_STEPS = {
    data:   '📊 Fetching data…',
    llm:    '🤖 Running AI…',
    saving: '💾 Saving…',
  }

  const PATH_MAP = {
    eod_orders:    '/reports/eod/orders',
    weekly_orders: '/reports/weekly/orders',
    eod_frac:      '/reports/eod/frac',
    weekly_frac:   '/reports/weekly/frac',
  }

  const triggerFn = async (kind) => {
    setBusy(kind); setTriggerErr(''); setGenStep('data')
    const stepTimer = setTimeout(() => setGenStep('llm'), 1800)
    try {
      const r = await fetch(`${API}${PATH_MAP[kind]}`, { headers: getAuthHeaders() })
      setGenStep('saving')
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || `Failed (${r.status})`)
      await reload()
      if (d.id) setSelectedId(d.id)
    } catch (e) {
      setTriggerErr(e.message || 'Generation failed')
      setTimeout(() => setTriggerErr(''), 5000)
    } finally {
      clearTimeout(stepTimer)
      setGenStep(null)
      setBusy(null)
    }
  }
  triggerFn.busy = busy
  triggerFn.step = genStep ? GEN_STEPS[genStep] : null

  const handleDelete = async (id) => {
    setDeletingId(id)
    try {
      await deleteReport(id)
      if (selectedId === id) setSelectedId(null)
      await reload()
    } finally {
      setDeletingId(null)
    }
  }

  const commonProps = {
    reports,
    trigger: triggerFn,
    triggerErr,
    selectedId,
    setSelectedId,
    deletingId,
    onDelete: handleDelete,
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>📑 Reports</h1>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>
          {reports.length} report{reports.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && <p className="settings-err">Could not load reports.</p>}

      {/* ── Tab bar ──────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid var(--border)', marginBottom: 20 }}>
        {[['orders', '📋 Orders'], ['frac', '🔢 Fractional']].map(([key, label]) => (
          <button
            key={key}
            className={`nav-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
            style={{
              borderRadius: 'var(--radius-sm, 6px) var(--radius-sm, 6px) 0 0',
              borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -2,
            }}
          >{label}</button>
        ))}
      </div>

      {/* ── Orders tab ───────────────────────────────────────────────────────── */}
      <div style={{ display: tab === 'orders' ? '' : 'none' }}>
        <TabPane
          {...commonProps}
          modeTypes={ORDERS_TYPES}
          busyKey={['eod_orders', 'weekly_orders']}
        />
      </div>

      {/* ── Frac tab ─────────────────────────────────────────────────────────── */}
      <div style={{ display: tab === 'frac' ? '' : 'none' }}>
        <TabPane
          {...commonProps}
          modeTypes={FRAC_TYPES}
          busyKey={['eod_frac', 'weekly_frac']}
        />
      </div>
    </div>
  )
}
