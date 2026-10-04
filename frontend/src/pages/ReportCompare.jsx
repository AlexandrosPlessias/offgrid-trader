import { useEffect, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine, LabelList,
  LineChart, Line, Legend, CartesianGrid,
} from 'recharts'
import { API, getAuthHeaders } from '../utils/api'
import { AXIS_TICK, CHART_TOOLTIP_STYLE } from '../utils/colors'
import { fmtNum, fmtTokens } from '../utils/fmt'

// Validated with the dataviz palette checker against the dark surface. A/B identity is
// blue/amber so it never collides with the improve/regress pair (teal/rose). Do not swap
// in CHART_GREEN/CHART_RED — red/green fails deuteranopia separation.
const COLOR_A = '#2563eb'
const COLOR_B = '#d97706'
const COLOR_IMPROVE = '#0d9488'
const COLOR_REGRESS = '#e11d48'
const COLOR_NEUTRAL = '#6b7280'

const MONEY_KEYS = new Set(['total_pnl', 'win_pnl', 'loss_pnl', 'notional_open'])
const HEADLINE_KEYS = ['total_pnl', 'win_rate', 'closed_trades']

const fmtMetric = (key, v) => {
  if (v == null) return '—'
  if (MONEY_KEYS.has(key)) return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`
  if (key === 'win_rate') return `${v.toFixed(1)}%`
  return fmtNum(Math.round(v * 100) / 100)
}
const fmtSignedPct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`)
const fmtDelta = (key, v) => {
  if (v == null) return '—'
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  if (MONEY_KEYS.has(key)) return `${sign}$${Math.abs(v).toFixed(2)}`
  if (key === 'win_rate') return `${sign}${Math.abs(v).toFixed(1)} pts`
  return `${sign}${fmtNum(Math.abs(Math.round(v * 100) / 100))}`
}

// Polarity is normalised by higher_is_better, never by the raw sign: a fall in losses
// or blocked trades is an improvement. null = directionless or undefined.
const polarity = m => {
  if (m.higher_is_better == null || m.delta == null || m.delta === 0) return 0
  return (m.delta > 0) === m.higher_is_better ? 1 : -1
}
const polarityColor = p => (p > 0 ? COLOR_IMPROVE : p < 0 ? COLOR_REGRESS : undefined)
const polarityGlyph = p => (p > 0 ? '▲' : p < 0 ? '▼' : '')

const CARD = {
  background: 'var(--bg-elev, rgba(255,255,255,.03))', border: '1px solid var(--border)',
  borderRadius: 10, padding: '12px 14px',
}
const CARD_TITLE = {
  fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.07em',
  marginBottom: 8, fontWeight: 700,
}
const TH = { textAlign: 'left', padding: '6px 10px', fontSize: 11, color: 'var(--dim)', borderBottom: '1px solid var(--border)' }
const TD = { padding: '6px 10px', fontSize: 12, borderBottom: '1px solid var(--border)' }
const NUM = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

const GRADE_STYLE = {
  full:    { bg: 'rgba(13,148,136,.15)', color: '#5eead4', label: 'Fully comparable' },
  partial: { bg: 'rgba(217,119,6,.15)',  color: '#fbbf24', label: 'Partially comparable' },
  none:    { bg: 'rgba(225,29,72,.15)',  color: '#fda4af', label: 'Not comparable' },
}
const VERDICT_STYLE = {
  improved:     { color: COLOR_IMPROVE, label: '▲ Improved' },
  regressed:    { color: COLOR_REGRESS, label: '▼ Regressed' },
  mixed:        { color: '#fbbf24',     label: '◆ Mixed' },
  inconclusive: { color: COLOR_NEUTRAL, label: '○ Inconclusive' },
}

function ComparabilityBadge({ grade, reasons }) {
  const s = GRADE_STYLE[grade] || GRADE_STYLE.partial
  return (
    <div style={{ background: s.bg, borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: s.color }}>{s.label}</div>
      {reasons?.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text)' }}>
          {reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
    </div>
  )
}

function DeltaTiles({ metrics }) {
  const rows = HEADLINE_KEYS.map(k => metrics.find(m => m.key === k)).filter(Boolean)
  if (!rows.length) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
      {rows.map(m => {
        const p = polarity(m)
        return (
          <div key={m.key} style={{ ...CARD, padding: '8px 14px', minWidth: 120, textAlign: 'center' }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{fmtMetric(m.key, m.b)}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: polarityColor(p) || 'var(--dim)' }}>
              {polarityGlyph(p)} {fmtDelta(m.key, m.delta)}
              {m.pct_delta != null && <span style={{ opacity: 0.8 }}> ({fmtSignedPct(m.pct_delta)})</span>}
            </div>
            <div style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
              {m.label} · was {fmtMetric(m.key, m.a)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WhatMovedChart({ metrics }) {
  const rows = metrics
    .filter(m => m.higher_is_better != null && m.pct_delta != null && m.delta !== 0)
    .map(m => {
      const p = polarity(m)
      return {
        name: m.label,
        key: m.key,
        // Signed so right = improved, left = regressed, whatever the raw direction.
        score: Math.abs(m.pct_delta) * p,
        p,
        raw: m,
      }
    })
    .sort((x, y) => Math.abs(y.score) - Math.abs(x.score))
  if (!rows.length) {
    return (
      <div style={{ ...CARD, marginBottom: 14 }}>
        <div style={CARD_TITLE}>What moved</div>
        <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>
          No metric with a clear good/bad direction changed, or report A had zero values to measure against.
        </p>
      </div>
    )
  }
  const nice = niceCeil(Math.max(...rows.map(r => Math.abs(r.score)), 1))
  // Headroom on the right for end labels; negative labels also sit right of zero.
  const domain = [-nice, nice * 1.35]
  return (
    <div style={{ ...CARD, marginBottom: 14 }}>
      <div style={CARD_TITLE}>What moved · % change, right = better</div>
      <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 34 + 30)}>
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 56, top: 4, bottom: 4 }} barCategoryGap={2}>
          <XAxis type="number" domain={domain} ticks={[-nice, 0, nice]} tick={AXIS_TICK} axisLine={false}
                 tickLine={false} tickFormatter={v => `${v > 0 ? '+' : ''}${Math.round(v)}%`} />
          <YAxis type="category" dataKey="name" width={120} tick={{ ...AXIS_TICK, fill: 'var(--text)', fontSize: 11 }}
                 axisLine={false} tickLine={false} />
          <ReferenceLine x={0} stroke={COLOR_NEUTRAL} strokeWidth={1} />
          <Tooltip
            {...CHART_TOOLTIP_STYLE}
            cursor={{ fill: 'rgba(255,255,255,.06)' }}
            formatter={(_v, _n, item) => {
              const m = item.payload.raw
              return [`${fmtMetric(m.key, m.a)} → ${fmtMetric(m.key, m.b)} (${fmtSignedPct(m.pct_delta)})`,
                      item.payload.p > 0 ? 'Improved' : 'Regressed']
            }}
          />
          <Bar dataKey="score" radius={4} minPointSize={2}>
            {rows.map((r, i) => <Cell key={i} fill={polarityColor(r.p)} />)}
            <LabelList
              dataKey="score"
              position="right"
              content={({ x, y, width, height, index }) => {
                const r = rows[index]
                // Right edge of the bar: its end when positive, the zero line when negative —
                // so labels never run into the category labels on the left.
                const tx = Math.max(x, x + width) + 6
                return (
                  <text x={tx} y={y + height / 2} dy={4} fontSize={11} fill="var(--text)" textAnchor="start">
                    {polarityGlyph(r.p)} {fmtSignedPct(r.raw.pct_delta)}
                  </text>
                )
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

const BUCKET_WORD = { day: 'Day', week: 'Week', month: 'Month' }

function niceCeil(v) {
  const mag = 10 ** Math.floor(Math.log10(v))
  const step = [1, 2, 2.5, 5, 10].find(m => m * mag >= v) ?? 10
  return step * mag
}
const fmtMoneyTick = v => {
  const a = Math.abs(v)
  return `${v < 0 ? '−' : ''}$${a < 10 ? a.toFixed(2) : Math.round(a)}`
}

function overlaySeries(bucketsA, bucketsB, pick) {
  const ka = Object.keys(bucketsA || {}).sort()
  const kb = Object.keys(bucketsB || {}).sort()
  const n = Math.max(ka.length, kb.length)
  return Array.from({ length: n }, (_, i) => ({
    idx: i + 1,
    a: ka[i] != null ? pick(bucketsA[ka[i]]) : null,
    b: kb[i] != null ? pick(bucketsB[kb[i]]) : null,
    aKey: ka[i], bKey: kb[i],
  }))
}

function OverlayChart({ title, data, word, format, lastIdx }) {
  return (
    <div style={{ ...CARD, flex: '1 1 280px' }}>
      <div style={CARD_TITLE}>{title}</div>
      <ResponsiveContainer width="100%" height={190}>
        <LineChart data={data} margin={{ left: 0, right: 24, top: 8, bottom: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
          <XAxis dataKey="idx" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => `${word[0]}${v}`} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={format} />
          <Tooltip
            {...CHART_TOOLTIP_STYLE}
            labelFormatter={v => `${word} ${v}`}
            formatter={(v, name, item) => {
              const key = name === 'Report A' ? item.payload.aKey : item.payload.bKey
              return [format(v), `${name}${key ? ` · ${key}` : ''}`]
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {[['a', 'Report A', COLOR_A], ['b', 'Report B', COLOR_B]].map(([k, name, color]) => (
            <Line key={k} type="monotone" dataKey={k} name={name} stroke={color} strokeWidth={2}
                  dot={{ r: 4, strokeWidth: 0, fill: color }} activeDot={{ r: 5 }} connectNulls={false}>
              <LabelList dataKey={k} content={({ x, y, index }) => (
                index === lastIdx[k] ? (
                  <text x={x + 6} y={y} dy={4} fontSize={11} fontWeight={700} fill={color}>{k.toUpperCase()}</text>
                ) : null
              )} />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function OverlayCharts({ buckets }) {
  const { granularity, a, b } = buckets || {}
  const hasA = a && (Object.keys(a.pnl).length || Object.keys(a.signals).length)
  const hasB = b && (Object.keys(b.pnl).length || Object.keys(b.signals).length)
  if (!granularity || !hasA || !hasB) return null
  const word = BUCKET_WORD[granularity] || 'Bucket'
  const pnl = overlaySeries(a.pnl, b.pnl, v => v.pnl ?? 0)
  const sig = overlaySeries(a.signals, b.signals, v => v.count ?? 0)
  const last = data => ({
    a: data.reduce((acc, d, i) => (d.a != null ? i : acc), -1),
    b: data.reduce((acc, d, i) => (d.b != null ? i : acc), -1),
  })
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
      {pnl.length > 0 && (
        <OverlayChart title={`Realized P&L per ${word.toLowerCase()}`} data={pnl} word={word}
                      format={fmtMoneyTick} lastIdx={last(pnl)} />
      )}
      {sig.length > 0 && (
        <OverlayChart title={`Signals per ${word.toLowerCase()}`} data={sig} word={word}
                      format={v => `${Math.round(v)}`} lastIdx={last(sig)} />
      )}
    </div>
  )
}

function MetricTable({ metrics }) {
  return (
    <div style={{ ...CARD, marginBottom: 14, overflowX: 'auto' }}>
      <div style={CARD_TITLE}>All metrics</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={TH}>Metric</th>
            <th style={{ ...TH, textAlign: 'right', color: COLOR_A }}>A</th>
            <th style={{ ...TH, textAlign: 'right', color: COLOR_B }}>B</th>
            <th style={{ ...TH, textAlign: 'right' }}>Δ</th>
            <th style={{ ...TH, textAlign: 'right' }}>%Δ</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map(m => {
            const p = polarity(m)
            const c = polarityColor(p)
            return (
              <tr key={m.key}>
                <td style={TD}>{m.label}</td>
                <td style={NUM}>{fmtMetric(m.key, m.a)}</td>
                <td style={NUM}>{fmtMetric(m.key, m.b)}</td>
                <td style={{ ...NUM, color: c, fontWeight: c ? 600 : 400 }}>
                  {polarityGlyph(p)} {fmtDelta(m.key, m.delta)}
                </td>
                <td style={{ ...NUM, color: c }}>{fmtSignedPct(m.pct_delta)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ConfigTable({ config, available }) {
  return (
    <div style={{ ...CARD, marginBottom: 14, overflowX: 'auto' }}>
      <div style={CARD_TITLE}>Configuration changes</div>
      {!available ? (
        <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>
          ⚠ At least one report predates configuration snapshots, so settings changes between them can't be shown.
        </p>
      ) : config.length === 0 ? (
        <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>
          No tuning setting changed between these reports.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>Setting</th>
              <th style={{ ...TH, textAlign: 'right', color: COLOR_A }}>A</th>
              <th style={{ ...TH, textAlign: 'right', color: COLOR_B }}>B</th>
            </tr>
          </thead>
          <tbody>
            {config.map(c => (
              <tr key={c.key}>
                <td style={{ ...TD, fontFamily: 'ui-monospace, monospace' }}>{c.key}</td>
                <td style={NUM}>{c.a ?? '—'}</td>
                <td style={{ ...NUM, fontWeight: 700 }}>{c.b ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function FindingList({ title, items, color, withCause }) {
  if (!items?.length) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...CARD_TITLE, color }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
        {items.map((f, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            {f.metric && <b>{f.metric}: </b>}{f.point}
            <div style={{ fontSize: 12, color: 'var(--dim)' }}>
              {f.evidence}{f.confidence && ` · ${f.confidence} confidence`}
            </div>
            {withCause && f.cause && <div style={{ fontSize: 12 }}>Cause: {f.cause}</div>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ReviewResult({ review }) {
  const v = VERDICT_STYLE[review.verdict] || VERDICT_STYLE.inconclusive
  const tokens = (review.prompt_tokens || 0) + (review.completion_tokens || 0)
  return (
    <div style={{ ...CARD, marginTop: 12 }}>
      <ComparabilityBadge grade={review.comparability} reasons={review.comparability_reasons} />
      <div style={{ fontSize: 16, fontWeight: 700, color: v.color, marginBottom: 6 }}>
        {v.label}
        {review.verdict_confidence && (
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}> · {review.verdict_confidence} confidence</span>
        )}
      </div>
      {review.summary && <p style={{ fontSize: 13, lineHeight: 1.55, margin: '0 0 10px' }}>{review.summary}</p>}
      {review.comparability_note && (
        <p className="text-dim" style={{ fontSize: 12, margin: '0 0 12px' }}>{review.comparability_note}</p>
      )}
      <FindingList title="✓ What's good" items={review.good} color={COLOR_IMPROVE} />
      <FindingList title="✗ What's bad" items={review.bad} color={COLOR_REGRESS} withCause />
      {review.improve?.length > 0 && (
        <div style={{ marginBottom: 12, overflowX: 'auto' }}>
          <div style={CARD_TITLE}>⚙ What to improve</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH}>Setting</th>
                <th style={TH}>Change</th>
                <th style={TH}>Why · expected effect</th>
                <th style={TH}>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {review.improve.map((s, i) => (
                <tr key={i}>
                  <td style={{ ...TD, fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>{s.setting}</td>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>{s.current_value || '—'} → <b>{s.proposed_value}</b></td>
                  <td style={TD}>{s.rationale}<div className="text-dim" style={{ fontSize: 11 }}>{s.expected_effect}</div></td>
                  <td style={TD}>{s.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {review.watch_next?.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={CARD_TITLE}>Watch next</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {review.watch_next.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      <div className="text-dim" style={{ fontSize: 11, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
        {review.model_used || 'model unknown'} · {fmtTokens(tokens)} tokens
      </div>
    </div>
  )
}

function ReportLabel({ side, meta }) {
  const color = side === 'A' ? COLOR_A : COLOR_B
  const w = meta?.window
  return (
    <div style={{ flex: '1 1 200px', borderLeft: `3px solid ${color}`, paddingLeft: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color }}>REPORT {side}</div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {w ? `${w.start} → ${w.end} (${w.days}d)` : meta?.report_date}
      </div>
      <div className="text-dim" style={{ fontSize: 12 }}>{meta?.headline || '(no headline)'}</div>
    </div>
  )
}

export default function ReportComparePanel({ ids, onClear }) {
  const [a, b] = ids
  const [diff, setDiff] = useState(null)
  const [error, setError] = useState('')
  const [review, setReview] = useState(null)
  const [reviewing, setReviewing] = useState(false)
  const [reviewError, setReviewError] = useState('')

  useEffect(() => {
    let cancelled = false
    setDiff(null); setError(''); setReview(null); setReviewError('')
    fetch(`${API}/reports/compare?a=${a}&b=${b}`, { headers: getAuthHeaders() })
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.detail || `Compare failed (${r.status})`)
        if (!cancelled) setDiff(d)
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Compare failed') })
    return () => { cancelled = true }
  }, [a, b])

  const runReview = async () => {
    setReviewing(true); setReviewError('')
    try {
      const r = await fetch(`${API}/reports/compare/review`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ a, b }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || `Review failed (${r.status})`)
      setReview(d)
    } catch (e) {
      setReviewError(e.message || 'Review failed')
    } finally {
      setReviewing(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>⚖ Compare reports</h2>
        <button className="btn-secondary btn-sm" onClick={onClear}>✕ Clear selection</button>
      </div>
      {error && <p className="settings-err">✗ {error}</p>}
      {!diff && !error && <p className="text-dim" style={{ fontSize: 13 }}>Loading comparison…</p>}
      {diff && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <ReportLabel side="A" meta={diff.a} />
            <ReportLabel side="B" meta={diff.b} />
          </div>
          <ComparabilityBadge grade={diff.comparability} reasons={diff.comparability_reasons} />
          {diff.metrics_basis === 'all_time' && (
            <p style={{ fontSize: 12, color: '#fbbf24', marginTop: -6 }}>
              ⚠ These figures are all-time totals, not per-period — at least one report predates window-scoped metrics.
            </p>
          )}
          <DeltaTiles metrics={diff.metrics} />
          <WhatMovedChart metrics={diff.metrics} />
          <OverlayCharts buckets={diff.buckets} />
          <MetricTable metrics={diff.metrics} />
          <ConfigTable config={diff.config} available={diff.config_available} />
          <button className="btn-primary btn-sm" onClick={runReview} disabled={reviewing}>
            {reviewing ? '⏳ Analysing…' : '🧠 Get trading-master review'}
          </button>
          {reviewError && <p className="settings-err" style={{ marginTop: 8 }}>✗ {reviewError}</p>}
          {review && <ReviewResult review={review} />}
        </>
      )}
    </div>
  )
}
