import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'

// ── Category chip colours — distinct, dark-theme-friendly ─────────────────────
// bg = subtle dark fill · color = bright readable text (mirrors PaperOrdersPanel chips)
const CATEGORY_STYLE = {
  scan:         { bg: '#12324d', color: '#5cc8ff' },  // blue
  order:        { bg: '#123524', color: '#69db7c' },  // green
  discovery:    { bg: '#3d2712', color: '#ffb454' },  // orange
  notification: { bg: '#2a1a3d', color: '#c98cff' },  // violet
  scheduler:    { bg: '#0f3538', color: '#4fd0d8' },  // teal
  system:       { bg: '#1e2130', color: '#9ba8c9' },  // slate — startup/shutdown/config
  report:       { bg: '#1a2e1a', color: '#7dde7d' },  // muted green — generated reports
}
const CATEGORIES = ['scan', 'order', 'discovery', 'notification', 'scheduler', 'system', 'report']

// Level accent — error red, warn amber, info none
const levelColor = (level) =>
  level === 'error' ? 'var(--red)' : level === 'warn' ? 'var(--yellow)' : null

// ISO-8601 UTC → local HH:MM:SS (24h)
const fmtHMS = (iso) => {
  if (!iso) return '--:--:--'
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
  } catch { return iso }
}
// Full local date+time — used as the timestamp hover title
const fmtFull = (iso) => {
  if (!iso) return ''
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

export default function EventsPage() {
  // usePolling handles fetch + auth (getAuthHeaders) internally — just pass the path.
  const { data, error, reload } = usePolling('/events?limit=100', 5000)
  const [filter, setFilter] = useState('all')

  const events = data?.events ?? []
  const shown  = filter === '__errors__' ? events.filter(e => e.level === 'error' || e.level === 'warn')
               : filter === 'all'        ? events
               :                          events.filter(e => e.category === filter)
  const errorCount = events.filter(e => e.level === 'error').length

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* ── Header row: title · count · refresh ─────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>📋 Activity</h1>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>
          {shown.length} event{shown.length === 1 ? '' : 's'} · live
        </span>
        <button
          onClick={reload}
          title="Refresh now"
          style={{
            marginLeft: 'auto', background: 'none', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--dim)', cursor: 'pointer', fontSize: 13, padding: '2px 9px',
          }}
        >⟳</button>
      </div>

      {/* ── Category filter ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {/* Errors shortcut — always first, distinct red styling */}
        <button
          onClick={() => setFilter('__errors__')}
          style={{
            padding: '3px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600,
            cursor: 'pointer',
            background: filter === '__errors__' ? 'color-mix(in srgb, var(--red) 18%, transparent)' : 'transparent',
            color: filter === '__errors__' ? 'var(--red)' : 'color-mix(in srgb, var(--red) 70%, var(--dim))',
            border: `1px solid ${filter === '__errors__' ? 'var(--red)' : 'color-mix(in srgb, var(--red) 35%, var(--border))'}`,
          }}
        >
          ⛔ Errors{errorCount > 0 ? ` (${errorCount})` : ''}
        </button>

        <span style={{ alignSelf: 'center', color: 'var(--border)', fontSize: 14 }}>|</span>

        {['all', ...CATEGORIES].map(cat => {
          const active = filter === cat
          const cs = CATEGORY_STYLE[cat]
          return (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              style={{
                padding: '3px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                cursor: 'pointer', textTransform: 'capitalize',
                background: active ? (cs ? cs.bg : 'var(--accent-dim)') : 'transparent',
                color:      active ? (cs ? cs.color : 'var(--accent)') : 'var(--dim)',
                border: `1px solid ${active ? (cs ? cs.color : 'var(--accent)') : 'var(--border)'}`,
              }}
            >
              {cat}
            </button>
          )
        })}
      </div>

      {/* ── Error state ─────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: 'color-mix(in srgb, var(--red) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
          color: 'var(--red)',
        }}>
          Could not load activity: {error}
        </div>
      )}

      {/* ── Loading (first fetch) ───────────────────────────────────────────── */}
      {!error && !data && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>
          Loading…
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {!error && data && shown.length === 0 && (
        <div style={{
          padding: '32px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 14,
          background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)',
        }}>
          No activity yet{filter !== 'all' ? ` in “${filter}”` : ''}.
        </div>
      )}

      {/* ── Feed (newest-first, scrollable) ─────────────────────────────────── */}
      {shown.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 5,
          maxHeight: 'calc(100vh - 250px)', minHeight: 120, overflowY: 'auto', paddingRight: 4,
        }}>
          {shown.map(ev => {
            const cs = CATEGORY_STYLE[ev.category] ?? { bg: '#26324a', color: '#9db2d6' }
            const lc = levelColor(ev.level)
            return (
              <div
                key={ev.id}
                style={{
                  display: 'flex', gap: 10, alignItems: 'baseline',
                  padding: '7px 11px', borderRadius: 7,
                  background: ev.level === 'error' ? 'color-mix(in srgb, var(--red) 9%, transparent)'
                            : ev.level === 'warn'  ? 'color-mix(in srgb, var(--yellow) 9%, transparent)'
                            : 'var(--surface)',
                  borderLeft: `3px solid ${lc ?? 'var(--border)'}`,
                }}
              >
                {/* Timestamp — monospace HH:MM:SS, full date on hover */}
                <span
                  title={fmtFull(ev.ts)}
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12, color: 'var(--dim)', whiteSpace: 'nowrap', flexShrink: 0,
                  }}
                >
                  {fmtHMS(ev.ts)}
                </span>

                {/* Category chip — category colour, level-coloured ring on warn/error */}
                <span
                  style={{
                    padding: '1px 7px', borderRadius: 5, fontSize: 11, fontWeight: 700,
                    background: cs.bg, color: cs.color, textTransform: 'uppercase',
                    letterSpacing: 0.4, whiteSpace: 'nowrap', flexShrink: 0,
                    border: `1px solid ${lc ?? 'transparent'}`,
                  }}
                >
                  {ev.category}
                </span>

                {/* Message — red on error, amber on warn; meta on hover */}
                <span
                  title={ev.meta ? JSON.stringify(ev.meta) : undefined}
                  style={{ fontSize: 13, color: lc ?? 'var(--text)', flex: 1, minWidth: 0, wordBreak: 'break-word' }}
                >
                  {ev.level === 'warn'  && <span style={{ marginRight: 5 }}>⚠</span>}
                  {ev.level === 'error' && <span style={{ marginRight: 5 }}>⛔</span>}
                  {ev.message}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
