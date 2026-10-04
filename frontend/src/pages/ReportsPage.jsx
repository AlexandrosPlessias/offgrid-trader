import { useState, useRef, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { usePolling } from '../hooks/usePolling'
import { API, getAuthHeaders } from '../utils/api'
import ReportComparePanel from './ReportCompare'

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
  monthly_orders:   { bg: '#3a2a10', color: '#f0b45a', label: 'Month Orders' },
  quarterly_orders: { bg: '#3a2a10', color: '#f0b45a', label: 'Qtr Orders' },
  yearly_orders:    { bg: '#3a2a10', color: '#f0b45a', label: 'Year Orders' },
  custom_orders:    { bg: '#2e2e2e', color: '#d0d0d0', label: 'Custom Orders' },
  monthly_frac:     { bg: '#2c1a33', color: '#e39be8', label: 'Month Frac' },
  quarterly_frac:   { bg: '#2c1a33', color: '#e39be8', label: 'Qtr Frac' },
  yearly_frac:      { bg: '#2c1a33', color: '#e39be8', label: 'Year Frac' },
  custom_frac:      { bg: '#2e2e2e', color: '#d0d0d0', label: 'Custom Frac' },
  // legacy types (kept for old records)
  eod:           { bg: '#12324d', color: '#5cc8ff',  label: 'EoD' },
  weekly:        { bg: '#2a1a3d', color: '#c98cff',  label: 'Weekly' },
  daily:         { bg: '#0f3538', color: '#4fd0d8',  label: 'Daily' },
}

const RANGE_PERIODS = ['monthly', 'quarterly', 'yearly', 'custom']
const ORDERS_TYPES = new Set(['eod_orders', 'weekly_orders', 'eod', 'daily', 'weekly',
                              ...RANGE_PERIODS.map(p => `${p}_orders`)])
const FRAC_TYPES   = new Set(['eod_frac', 'weekly_frac', ...RANGE_PERIODS.map(p => `${p}_frac`)])

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

// ── Shared report-body parsers (used by viewer + PDF) ─────────────────────────

function parseReportSections(fullBody) {
  const sections = []
  let curTitle = null, curLines = []
  for (const line of (fullBody || '').split('\n')) {
    const m = line.match(/^──\s+(.+?)\s+──$/)
    if (m) {
      if (curTitle !== null) sections.push({ title: curTitle, lines: curLines })
      curTitle = m[1]; curLines = []
    } else if (curTitle !== null) { curLines.push(line) }
  }
  if (curTitle !== null) sections.push({ title: curTitle, lines: curLines })
  return sections
}

function parseAISection(lines) {
  let mode = 'commentary', commentary = [], patterns = [], suggestions = []
  const tuningItems = []; let curTuning = null
  for (const line of lines) {
    if (line === 'Patterns:')         { mode = 'patterns';    continue }
    if (line === 'Suggestions:')      { mode = 'suggestions'; continue }
    if (line === 'Parameter tuning:') { mode = 'tuning';      continue }
    if (line.startsWith('— generated by ')) continue
    if (mode === 'commentary') { commentary.push(line) }
    else if (mode === 'patterns'    && line.trim().startsWith('• ')) patterns.push(line.trim().slice(2))
    else if (mode === 'suggestions' && line.trim().startsWith('• ')) suggestions.push(line.trim().slice(2))
    else if (mode === 'tuning') {
      if (line.trim().startsWith('• ')) {
        if (curTuning) tuningItems.push(curTuning)
        const raw = line.trim().slice(2), ci = raw.indexOf(':')
        curTuning = ci > -1
          ? { setting: raw.slice(0, ci).trim(), change: raw.slice(ci + 1).trim(), reason: '' }
          : { setting: raw, change: '', reason: '' }
      } else if (curTuning && line.trim()) { curTuning.reason = line.trim() }
    }
  }
  if (curTuning) tuningItems.push(curTuning)
  return { commentary: commentary.join('\n').trim(), patterns, suggestions, tuningItems }
}

function isKVSection(lines) {
  return lines.some(l => /^\s{2,}\S/.test(l) && l.includes(':'))
}

// ── Structured body renderer (React) ──────────────────────────────────────────

const SEC_TITLE_STYLE = {
  fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em',
  color: 'var(--accent, #60a5fa)', paddingBottom: 6,
  borderBottom: '1px solid var(--border)', marginBottom: 10,
}
const TH_STYLE = {
  padding: '5px 10px', fontSize: 11, fontWeight: 700, textAlign: 'left',
  background: 'rgba(96,165,250,.08)', color: 'var(--accent, #60a5fa)',
  borderBottom: '1px solid var(--border)',
}
const TD_STYLE  = { padding: '5px 10px', fontSize: 12, borderBottom: '1px solid var(--border)', verticalAlign: 'top', wordBreak: 'break-word', whiteSpace: 'normal' }
const KL_STYLE  = { ...TD_STYLE, fontWeight: 600, color: 'var(--accent, #60a5fa)', width: '34%', background: 'rgba(96,165,250,.04)' }
const MONO_STYLE = { ...TD_STYLE, fontFamily: 'ui-monospace,SFMono-Regular,monospace', fontSize: 11, fontWeight: 700, color: '#60a5fa', width: '20%' }
const TABLE_STYLE = { width: '100%', borderCollapse: 'collapse', fontSize: 12, borderRadius: 6, overflow: 'hidden' }
const SUB_STYLE = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--dim)', margin: '14px 0 6px' }

function KVBlock({ lines }) {
  const pairs = []
  for (const line of lines) {
    if (!line.trim()) continue
    const ci = line.indexOf(':')
    if (ci > -1) pairs.push([line.slice(0, ci).trim(), line.slice(ci + 1).trim()])
    else pairs.push([line.trim(), ''])
  }
  if (!pairs.length) return <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic' }}>No data.</p>
  return (
    <table style={TABLE_STYLE}>
      <tbody>
        {pairs.map(([k, v], i) => (
          <tr key={i} style={{ background: i % 2 === 1 ? 'rgba(255,255,255,.02)' : 'transparent' }}>
            <td style={KL_STYLE}>{k}</td>
            <td style={TD_STYLE}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ItemsBlock({ lines }) {
  const rows = lines.map(l => l.trim()).filter(l => l && l !== '(none)').map(l => l.split(/\s{2,}/))
  if (!rows.length) return <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic' }}>(none)</p>
  return (
    <table style={TABLE_STYLE}>
      <tbody>
        {rows.map((cols, i) => (
          <tr key={i} style={{ background: i % 2 === 1 ? 'rgba(255,255,255,.02)' : 'transparent' }}>
            {cols.map((c, j) => <td key={j} style={TD_STYLE}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AIBlock({ lines }) {
  const { commentary, patterns, suggestions, tuningItems } = parseAISection(lines)
  return (
    <div>
      {commentary && (
        <p style={{ lineHeight: 1.7, fontSize: 13, color: 'var(--text)', marginBottom: patterns.length || suggestions.length || tuningItems.length ? 12 : 0 }}>
          {commentary}
        </p>
      )}
      {patterns.length > 0 && (
        <>
          <div style={SUB_STYLE}>Patterns</div>
          <ul style={{ paddingLeft: 20, marginBottom: 8 }}>
            {patterns.map((p, i) => <li key={i} style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 4 }}>{p}</li>)}
          </ul>
        </>
      )}
      {suggestions.length > 0 && (
        <>
          <div style={SUB_STYLE}>Suggestions</div>
          <ul style={{ paddingLeft: 20, marginBottom: 8 }}>
            {suggestions.map((s, i) => <li key={i} style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 4 }}>💡 {s}</li>)}
          </ul>
        </>
      )}
      {tuningItems.length > 0 && (
        <>
          <div style={SUB_STYLE}>Parameter Tuning</div>
          <table style={TABLE_STYLE}>
            <thead>
              <tr>
                <th style={{ ...TH_STYLE, width: '20%' }}>Setting</th>
                <th style={{ ...TH_STYLE, width: '25%' }}>Change</th>
                <th style={TH_STYLE}>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {tuningItems.map((t, i) => (
                <tr key={i} style={{ background: i % 2 === 1 ? 'rgba(255,255,255,.02)' : 'transparent' }}>
                  <td style={MONO_STYLE}>{t.setting}</td>
                  <td style={TD_STYLE}>{t.change}</td>
                  <td style={{ ...TD_STYLE, color: 'var(--dim)' }}>{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function StructuredReportBody({ fullBody }) {
  const sections = parseReportSections(fullBody)
  if (!sections.length) return <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic' }}>(empty)</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {sections.map((sec, i) => (
        <div key={i}>
          <div style={SEC_TITLE_STYLE}>{sec.title}</div>
          {sec.title === 'AI analysis'
            ? <AIBlock lines={sec.lines} />
            : isKVSection(sec.lines)
              ? <KVBlock lines={sec.lines} />
              : <ItemsBlock lines={sec.lines} />
          }
        </div>
      ))}
    </div>
  )
}

// ── Report viewer ─────────────────────────────────────────────────────────────

function ReportViewer({ report }) {
  const [version,   setVersion]   = useState('full')
  const [copyState, setCopyState] = useState(null)  // null | 'copying' | 'ok'
  const [dlOpen,    setDlOpen]    = useState(false)
  const dlRef    = useRef(null)
  const chartsRef = useRef(null)

  useEffect(() => {
    if (!dlOpen) return
    const handler = (e) => { if (dlRef.current && !dlRef.current.contains(e.target)) setDlOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dlOpen])

  if (!report) return <p className="text-dim">Select a report from the history, or generate one.</p>

  const body = version === 'full' ? (report.full_body || '') : (report.notification_body || '')

  const slug = () => (report.report_date || fmtDateTime(report.created_at)).replace(/[/:, ]/g, '-')

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

  const downloadPDF = () => {
    const win = window.open('', '_blank', 'width=900,height=750')
    if (!win) return
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const TYPE_LABEL = {
      eod_orders: 'EoD — Orders', weekly_orders: 'Weekly — Orders', eod_frac: 'EoD — Fractional', weekly_frac: 'Weekly — Fractional',
      monthly_orders: 'Monthly — Orders', quarterly_orders: 'Quarterly — Orders', yearly_orders: 'Yearly — Orders', custom_orders: 'Custom range — Orders',
      monthly_frac: 'Monthly — Fractional', quarterly_frac: 'Quarterly — Fractional', yearly_frac: 'Yearly — Fractional', custom_frac: 'Custom range — Fractional',
    }

    // ── Capture charts as inline SVGs ─────────────────────────────────────────
    const svgEls = chartsRef.current ? Array.from(chartsRef.current.querySelectorAll('svg')) : []
    let chartsHTML = ''
    if (svgEls.length) {
      const svgBlocks = svgEls.map(svg => {
        const clone = svg.cloneNode(true)
        // Force print-friendly colours over any CSS variable references
        clone.setAttribute('style', 'background:transparent')
        return clone.outerHTML
          .replace(/var\(--dim\)/g, '#6b7280')
          .replace(/var\(--text\)/g, '#374151')
          .replace(/var\(--border\)/g, '#e2e8f0')
          .replace(/var\(--bg-elev[^)]*\)/g, 'transparent')
          .replace(/var\(--accent[^)]*\)/g, '#2563eb')
          .replace(/rgba\(255,255,255,[.\d]+\)/g, 'transparent')
      })
      chartsHTML = `<div class="section"><div class="section-title">Charts</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;align-items:start">
${svgBlocks.map(s => `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;background:#f8fafc">${s}</div>`).join('\n')}
</div></div>`
    }

    // ── Parse full_body into sections ─────────────────────────────────────────
    const rawSections = parseReportSections(report.full_body)

    // ── Renderers ─────────────────────────────────────────────────────────────
    const renderKV = (lines) => {
      const pairs = []
      for (const line of lines) {
        if (!line.trim()) continue
        const ci = line.indexOf(':')
        if (ci > -1) pairs.push([line.slice(0, ci).trim(), line.slice(ci + 1).trim()])
        else pairs.push([line.trim(), ''])
      }
      if (!pairs.length) return '<p class="none">No data.</p>'
      let html = '<table><thead><tr><th>Metric</th><th>Value</th><th>Metric</th><th>Value</th></tr></thead><tbody>'
      for (let i = 0; i < pairs.length; i += 2) {
        const [k1, v1] = pairs[i], [k2, v2] = pairs[i + 1] || ['', '']
        html += `<tr><td class="kl">${esc(k1)}</td><td>${esc(v1)}</td><td class="kl">${esc(k2)}</td><td>${esc(v2)}</td></tr>`
      }
      return html + '</tbody></table>'
    }

    const renderItems = (lines) => {
      const items = lines.map(l => l.trim()).filter(l => l && l !== '(none)')
      if (!items.length) return '<p class="none">(none)</p>'
      let html = '<table><tbody>'
      for (const item of items) {
        const cols = item.split(/\s{2,}/)
        html += '<tr>' + cols.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>'
      }
      return html + '</tbody></table>'
    }

    const renderAI = (lines) => {
      let mode = 'commentary', commentary = [], patterns = [], suggestions = []
      const tuningItems = []
      let curTuning = null
      for (const line of lines) {
        if (line === 'Patterns:')        { mode = 'patterns';    continue }
        if (line === 'Suggestions:')     { mode = 'suggestions'; continue }
        if (line === 'Parameter tuning:'){ mode = 'tuning';      continue }
        if (line.startsWith('— generated by ')) continue
        if (mode === 'commentary') { commentary.push(line) }
        else if (mode === 'patterns' && line.trim().startsWith('• ')) { patterns.push(line.trim().slice(2)) }
        else if (mode === 'suggestions' && line.trim().startsWith('• ')) { suggestions.push(line.trim().slice(2)) }
        else if (mode === 'tuning') {
          if (line.trim().startsWith('• ')) {
            if (curTuning) tuningItems.push(curTuning)
            const raw = line.trim().slice(2)
            const ci = raw.indexOf(':')
            curTuning = ci > -1
              ? { setting: raw.slice(0, ci).trim(), change: raw.slice(ci + 1).trim(), reason: '' }
              : { setting: raw, change: '', reason: '' }
          } else if (curTuning && line.trim()) { curTuning.reason = line.trim() }
        }
      }
      if (curTuning) tuningItems.push(curTuning)
      let html = ''
      const prose = commentary.join('\n').trim()
      if (prose) html += `<p class="prose">${esc(prose).replace(/\n/g, '<br>')}</p>`
      if (patterns.length)    html += `<div class="sub">Patterns</div><ul>${patterns.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`
      if (suggestions.length) html += `<div class="sub">Suggestions</div><ul>${suggestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`
      if (tuningItems.length) {
        html += `<div class="sub">Parameter Tuning</div>
<table><thead><tr><th style="width:22%">Setting</th><th style="width:28%">Change</th><th>Rationale</th></tr></thead><tbody>`
        for (const t of tuningItems)
          html += `<tr><td class="mono">${esc(t.setting)}</td><td>${esc(t.change)}</td><td style="word-break:break-word;white-space:normal">${esc(t.reason)}</td></tr>`
        html += '</tbody></table>'
      }
      return html
    }

    // ── Assemble sections ─────────────────────────────────────────────────────
    let sectionsHTML = chartsHTML   // charts first, then text sections
    for (const sec of rawSections) {
      const isAI = sec.title === 'AI analysis'
      const inner = isAI
        ? renderAI(sec.lines)
        : isKVSection(sec.lines)
          ? renderKV(sec.lines)
          : renderItems(sec.lines)
      sectionsHTML += `<div class="section"><div class="section-title">${esc(sec.title)}</div>${inner}</div>`
    }

    const label = TYPE_LABEL[report.type] || (report.type || 'Report')
    const dateStr = esc(report.report_date || fmtDateTime(report.created_at))
    const modelStr = report.model ? ` · ${esc(report.model)}` : ''

    win.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MarketSage Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:#0f172a;background:#fff}
.page{max-width:820px;margin:0 auto;padding:40px}
.header{border-bottom:3px solid #2563eb;padding-bottom:16px;margin-bottom:26px}
.brand{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#2563eb;margin-bottom:8px}
h1{font-size:19px;font-weight:700;color:#0f172a;margin-bottom:5px;line-height:1.3}
.badge{display:inline-block;font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:#dbeafe;color:#1e40af;letter-spacing:.05em;vertical-align:middle;margin-left:8px;position:relative;top:-2px}
.meta{font-size:11px;color:#64748b}
.section{margin-bottom:22px;break-inside:avoid}
.section-title{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#2563eb;padding-bottom:5px;border-bottom:1.5px solid #bfdbfe;margin-bottom:10px}
.sub{font-size:11px;font-weight:700;color:#334155;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:2px}
th{background:#eff6ff;font-weight:700;text-align:left;padding:5px 9px;border:1px solid #bfdbfe;color:#1e3a5f;font-size:10.5px}
td{padding:5px 9px;border:1px solid #e2e8f0;vertical-align:top;line-height:1.5}
tr:nth-child(even) td{background:#f8fafc}
td.kl{font-weight:600;color:#1e3a5f;background:#f0f4ff;width:22%}
td.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;font-weight:600;color:#1d4ed8}
.prose{line-height:1.7;color:#334155;margin-bottom:8px}
ul{padding-left:20px}
li{margin-bottom:5px;line-height:1.55;color:#334155}
.none{font-size:12px;color:#94a3b8;font-style:italic}
.footer{margin-top:36px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;display:flex;justify-content:space-between}
@media print{.page{padding:24px}body{font-size:12px}}
</style></head><body>
<div class="page">
  <div class="header">
    <div class="brand">MarketSage</div>
    <h1>${esc(report.headline || label)}<span class="badge">${esc(label)}</span></h1>
    <div class="meta">${dateStr}${modelStr}</div>
  </div>
  ${sectionsHTML}
  <div class="footer"><span>MarketSage · For educational purposes only</span><span>${dateStr}</span></div>
</div>
<script>window.onload=function(){window.print()}</script>
</body></html>`)
    win.document.close()
    setDlOpen(false)
  }

  const downloadExcel = () => {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = [
      ['Field', 'Value'],
      ['Type',         report.type],
      ['Date',         report.report_date || fmtDateTime(report.created_at)],
      ['Headline',     report.headline || ''],
      ['Model',        report.model || ''],
      ['Full Report',  report.full_body || ''],
      ['Notification', report.notification_body || ''],
    ]
    const csv = rows.map(r => r.map(esc).join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `report-${report.type}-${slug()}.csv`; a.click()
    URL.revokeObjectURL(url)
    setDlOpen(false)
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
          <div ref={dlRef} style={{ position: 'relative' }}>
            <button className="btn-secondary btn-sm" onClick={() => setDlOpen(o => !o)}>
              ↓ Download ▾
            </button>
            {dlOpen && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 100,
                background: 'var(--bg-card, #1a1d2e)', border: '1px solid var(--border)',
                borderRadius: 8, padding: 4, minWidth: 140, boxShadow: '0 4px 16px rgba(0,0,0,.4)',
              }}>
                {[
                  { label: '📄 PDF', action: downloadPDF },
                  { label: '📊 Excel (CSV)', action: downloadExcel },
                ].map(({ label, action }) => (
                  <button
                    key={label}
                    onClick={action}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      fontSize: 13, color: 'var(--text)', borderRadius: 5,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,.07))'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >{label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <BlockedBanner report={report} />

      {/* ── Charts (full view only) ────────────────────────────────────────── */}
      {version === 'full' && (
        <div ref={chartsRef}>
          <ReportCharts report={report} />
        </div>
      )}

      {/* ── Report body ───────────────────────────────────────────────────── */}
      {version === 'full'
        ? (
          <div style={{
            background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
            borderRadius: 10, padding: 18,
          }}>
            <StructuredReportBody fullBody={report.full_body} />
          </div>
        ) : (
          <pre style={{
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.6,
            background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
            borderRadius: 10, padding: 16, margin: 0, fontFamily: 'inherit',
          }}>{body || '(empty)'}</pre>
        )
      }
    </>
  )
}

function HistoryList({ reports, selectedId, onSelect, onDelete, deletingId, compareSel, onToggleCompare }) {
  const firstType = compareSel.length ? reports.find(r => r.id === compareSel[0])?.type : null
  if (reports.length === 0) return (
    <p className="text-dim" style={{ fontSize: 13 }}>No reports yet — generate one above.</p>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {reports.map(r => {
        const active = r.id === selectedId
        const isDeleting = deletingId === r.id
        const picked = compareSel.includes(r.id)
        const typeMismatch = firstType != null && !picked && r.type !== firstType
        const compareDisabled = !picked && (compareSel.length >= 2 || typeMismatch)
        return (
          <div
            key={r.id}
            style={{
              borderRadius: 8,
              border: `1px solid ${picked ? '#2563eb' : active ? 'var(--accent)' : 'var(--border)'}`,
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
            <div style={{ padding: '0 6px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label
                title={typeMismatch ? 'Only reports of the same type can be compared'
                  : compareSel.length >= 2 && !picked ? 'Two reports already selected' : 'Select to compare'}
                onClick={e => e.stopPropagation()}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dim)',
                         padding: '2px 4px', cursor: compareDisabled ? 'not-allowed' : 'pointer',
                         opacity: compareDisabled ? 0.4 : 1 }}
              >
                <input type="checkbox" checked={picked} disabled={compareDisabled}
                       onChange={() => onToggleCompare(r.id)} />
                Compare
              </label>
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

const RANGE_PRESETS = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly'], ['custom', 'Custom']]

function RangeReportControl({ mode, runRange, busy, step }) {
  const today = new Date().toISOString().slice(0, 10)
  const [period, setPeriod] = useState('monthly')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState(today)
  const [notify, setNotify] = useState(false)
  const busyKey = `range_${mode}`
  const customInvalid = period === 'custom' && (!start || !end || start > end)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                    letterSpacing: '0.08em', marginBottom: 6 }}>On-demand range</div>
      <div className="filter-group" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
        {RANGE_PRESETS.map(([key, label]) => (
          <button key={key} className={`filter-btn ${period === key ? 'active' : ''}`}
                  onClick={() => setPeriod(key)}>{label}</button>
        ))}
      </div>
      {period === 'custom' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <input type="date" className="settings-select" value={start} max={end || today}
                 onChange={e => setStart(e.target.value)} aria-label="Range start" />
          <input type="date" className="settings-select" value={end} min={start} max={today}
                 onChange={e => setEnd(e.target.value)} aria-label="Range end" />
        </div>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--dim)', marginBottom: 6 }}>
        <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
        Also send to ntfy / Telegram
      </label>
      <button className="btn-secondary btn-sm" disabled={busy !== null || customInvalid}
              onClick={() => runRange({ mode, period, start, end, notify })}>
        {busy === busyKey ? `⏳ ${step ?? 'Generating…'}` : '⟳ Run range report'}
      </button>
    </div>
  )
}

function TabPane({ reports, modeTypes, trigger, busyKey, triggerErr, selectedId, setSelectedId, deletingId, onDelete,
                   compareSel, onToggleCompare, clearCompare, runRange }) {
  const filtered = reports.filter(r => modeTypes.has(r.type))
  const selected = filtered.find(r => r.id === selectedId) ?? filtered[0] ?? null
  // Both tab panes stay mounted, so only act on picks that belong to this pane.
  const tabSel = compareSel.filter(id => filtered.some(r => r.id === id))

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
        <RangeReportControl mode={isFrac ? 'frac' : 'orders'} runRange={runRange}
                            busy={trigger.busy} step={trigger.step} />
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.08em', marginBottom: 8 }}>
          History · {filtered.length}
          {tabSel.length === 1 && (
            <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}> · pick one more to compare</span>
          )}
        </div>
        <HistoryList
          reports={filtered}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          onDelete={onDelete}
          deletingId={deletingId}
          compareSel={tabSel}
          onToggleCompare={onToggleCompare}
        />
      </div>

      {/* ── Viewer / comparison ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 300 }}>
        {tabSel.length === 2
          ? <ReportComparePanel ids={tabSel} onClear={clearCompare} />
          : <ReportViewer report={selected} />}
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
  const [compareSel, setCompareSel] = useState([])     // up to 2 report ids, same type

  const toggleCompare = (id) => setCompareSel(sel =>
    sel.includes(id) ? sel.filter(x => x !== id) : sel.length >= 2 ? sel : [...sel, id])
  const clearCompare = () => setCompareSel([])
  const switchTab = (key) => { setTab(key); setCompareSel([]) }

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

  const generate = async (kind, path) => {
    setBusy(kind); setTriggerErr(''); setGenStep('data')
    const stepTimer = setTimeout(() => setGenStep('llm'), 1800)
    try {
      const r = await fetch(`${API}${path}`, { headers: getAuthHeaders() })
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
  const triggerFn = (kind) => generate(kind, PATH_MAP[kind])
  const runRange = ({ mode, period, start, end, notify }) => {
    const qs = new URLSearchParams({ mode, notify: String(notify) })
    if (period === 'custom') { qs.set('start', start); qs.set('end', end) } else qs.set('period', period)
    return generate(`range_${mode}`, `/reports/range?${qs}`)
  }
  triggerFn.busy = busy
  triggerFn.step = genStep ? GEN_STEPS[genStep] : null

  const handleDelete = async (id) => {
    setDeletingId(id)
    try {
      await deleteReport(id)
      if (selectedId === id) setSelectedId(null)
      setCompareSel(sel => sel.filter(x => x !== id))
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
    compareSel,
    onToggleCompare: toggleCompare,
    clearCompare,
    runRange,
  }

  return (
    // width + minWidth: fill <main> (a flex row) without letting wide tables grow the page.
    <div style={{ maxWidth: 960, width: '100%', minWidth: 0, margin: '0 auto' }}>
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
            onClick={() => switchTab(key)}
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
