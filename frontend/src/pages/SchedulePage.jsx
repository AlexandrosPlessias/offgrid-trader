import { useState, useEffect } from 'react'
import { API, getAuthHeaders } from '../utils/api'

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

const DISPLAY_TZ = 'Europe/Athens'

function fmtLocal(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function fmtUTC(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date) + ' UTC'
}

function parseHHMM(hhmm, date, tz) {
  const [h, m] = hhmm.split(':').map(Number)
  const str = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
  const utcOffset = getUTCOffsetMinutes(tz, date)
  return new Date(new Date(str + 'Z').getTime() - utcOffset * 60000)
}

function getUTCOffsetMinutes(tz, date) {
  const utcStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'shortOffset' }).format(date)
  const match = utcStr.match(/GMT([+-]\d+(?::\d+)?)/)
  if (!match) return 0
  const parts = match[1].split(':')
  const h = parseInt(parts[0], 10)
  const m = parts[1] ? parseInt(parts[1], 10) : 0
  return h * 60 + (h < 0 ? -m : m)
}

// Athens is GMT+2 in winter and GMT+3 on summer time — derive the label rather than
// hardcoding it, so it can never disagree with the times rendered beside it.
function fmtTZLabel(tz, date) {
  const mins = getUTCOffsetMinutes(tz, date)
  const sign = mins < 0 ? '-' : '+'
  const h = Math.floor(Math.abs(mins) / 60)
  const m = Math.abs(mins) % 60
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}

function getMondayOfWeek(now) {
  const d = new Date(now)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function buildEvents(dayDate, marketHours, scanIntervalMinutes, fracPollSeconds) {
  const tz = marketHours.timezone || 'America/New_York'
  const openTime = parseHHMM(marketHours.open, dayDate, tz)
  const closeTime = parseHHMM(marketHours.close, dayDate, tz)

  const events = []

  const wakeTime = new Date(openTime.getTime() - 60 * 60000)
  events.push({ time: wakeTime, label: 'System wake (Fly start)', color: '#6b7280', bg: '#1c1e26' })

  events.push({ time: openTime, label: 'Market opens', color: '#22c55e', bg: '#0f2d1a' })

  const scanMs = (scanIntervalMinutes || 15) * 60000
  const scanTimes = []
  let t = new Date(openTime.getTime())
  while (t <= closeTime) {
    scanTimes.push(new Date(t))
    t = new Date(t.getTime() + scanMs)
  }
  if (scanTimes.length <= 6) {
    scanTimes.forEach(st => {
      events.push({ time: st, label: `Signal scan`, color: '#60a5fa', bg: '#0f1d30' })
    })
  } else {
    scanTimes.slice(0, 3).forEach(st => {
      events.push({ time: st, label: `Signal scan`, color: '#60a5fa', bg: '#0f1d30' })
    })
    events.push({ time: null, label: `… every ${scanIntervalMinutes}m`, color: '#4b7ab5', bg: 'transparent', summary: true })
    scanTimes.slice(-3).forEach(st => {
      events.push({ time: st, label: `Signal scan`, color: '#60a5fa', bg: '#0f1d30' })
    })
  }

  let hourCursor = new Date(openTime)
  hourCursor.setMinutes(0, 0, 0)
  if (hourCursor < openTime) hourCursor = new Date(hourCursor.getTime() + 3600000)
  while (hourCursor < closeTime) {
    events.push({ time: new Date(hourCursor), label: 'Discovery run', color: '#a78bfa', bg: '#1e1030' })
    hourCursor = new Date(hourCursor.getTime() + 3600000)
  }

  events.push({ time: closeTime, label: 'Market closes', color: '#ef4444', bg: '#2d0f0f' })

  const eodTime = new Date(closeTime.getTime() + 65 * 60000)
  events.push({ time: eodTime, label: 'EOD report', color: '#f97316', bg: '#2d1a0a' })

  if (dayDate.getDay() === 5) {
    const eowTime = new Date(closeTime.getTime() + 85 * 60000)
    events.push({ time: eowTime, label: 'End-of-Week report', color: '#e879f9', bg: '#2d0f2d' })
  }

  const stopTime = new Date(closeTime.getTime() + 90 * 60000)
  events.push({ time: stopTime, label: 'System stop (Fly)', color: '#6b7280', bg: '#1c1e26' })

  events.sort((a, b) => {
    if (!a.time) return 0
    if (!b.time) return 0
    return a.time - b.time
  })

  return events
}

function isMarketOpen(now, marketHours) {
  if (!marketHours) return false
  const tz = marketHours.timezone || 'America/New_York'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const dayStr = parts.find(p => p.type === 'weekday')?.value
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
  const dayIdx = dayMap[dayStr] ?? -1
  const tradingDays = marketHours.trading_days || [0, 1, 2, 3, 4]
  if (!tradingDays.includes(dayIdx)) return false
  const [oh, om] = (marketHours.open || '09:30').split(':').map(Number)
  const [ch, cm] = (marketHours.close || '16:00').split(':').map(Number)
  const nowMin = hour * 60 + minute
  return nowMin >= oh * 60 + om && nowMin < ch * 60 + cm
}

function timeAgo(iso) {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const timeStr = fmtLocal(new Date(iso))
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago (${timeStr})`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago (${timeStr})`
  return `${Math.floor(diff / 3600000)}h ago (${timeStr})`
}

function timeUntil(iso) {
  if (!iso) return 'unknown'
  const diff = new Date(iso).getTime() - Date.now()
  const timeStr = fmtLocal(new Date(iso))
  if (diff <= 0) return `now (${timeStr})`
  if (diff < 60000) return `in ${Math.floor(diff / 1000)}s (${timeStr})`
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m (${timeStr})`
  return `in ${Math.floor(diff / 3600000)}h (${timeStr})`
}

export default function SchedulePage() {
  const [settings, setSettings] = useState(null)
  const [health, setHealth] = useState(null)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    fetch(`${API}/settings`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setSettings(d))
      .catch(() => {})
    fetch(`${API}/health`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setHealth(d))
      .catch(() => {})
    const interval = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(interval)
  }, [])

  const marketHours = settings?.market_hours
  const scanIntervalMinutes = settings?.scan_interval_minutes || 15
  const fracPollSeconds = settings?.frac_poll_seconds || 300
  const tz = marketHours?.timezone || 'America/New_York'

  const monday = getMondayOfWeek(now)
  const weekDays = DAY_NAMES.map((name, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })

  const todayET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long',
  }).format(now)
  const todayColIdx = DAY_NAMES.findIndex(n => n === todayET)
  const marketOpen = isMarketOpen(now, marketHours)

  const schedulerRunning = health?.scheduler?.running ?? false
  const lastRun = health?.scheduler?.last_run
  const nextRun = health?.scheduler?.next_run

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 8px' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Weekly Schedule</h1>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>
          Times shown in {fmtTZLabel(DISPLAY_TZ, new Date())} (Athens) · hover for UTC
        </span>
      </div>

      {!marketHours && (
        <div style={{ color: 'var(--dim)', fontSize: 13, padding: 24 }}>Loading schedule…</div>
      )}

      {marketHours && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
          {weekDays.map((dayDate, i) => {
            const isToday = i === todayColIdx
            const events = buildEvents(dayDate, marketHours, scanIntervalMinutes, fracPollSeconds)
            const dateLabel = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

            let currentTimePct = null
            if (isToday && marketOpen && marketHours) {
              const openTime = parseHHMM(marketHours.open, dayDate, tz)
              const closeTime = parseHHMM(marketHours.close, dayDate, tz)
              const total = closeTime - openTime
              const elapsed = now - openTime
              currentTimePct = Math.max(0, Math.min(100, (elapsed / total) * 100))
            }

            return (
              <div
                key={i}
                style={{
                  background: 'var(--surface)',
                  border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 10,
                  overflow: 'hidden',
                }}
              >
                <div style={{
                  padding: '8px 10px',
                  borderBottom: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                  background: isToday ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: isToday ? 'var(--accent)' : 'var(--text)' }}>
                    {DAY_NAMES[i]}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--dim)' }}>{dateLabel}</div>
                </div>

                <div style={{ padding: '6px 0', position: 'relative' }}>
                  {currentTimePct !== null && (
                    <div style={{
                      position: 'absolute',
                      left: 0, right: 0,
                      top: `${currentTimePct}%`,
                      height: 2,
                      background: '#ef4444',
                      zIndex: 2,
                      pointerEvents: 'none',
                    }} />
                  )}
                  {events.map((ev, j) => (
                    <div
                      key={j}
                      title={ev.time ? fmtUTC(ev.time) : undefined}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 8px',
                        opacity: ev.summary ? 0.6 : 1,
                      }}
                    >
                      {!ev.summary && (
                        <div style={{
                          width: 3,
                          alignSelf: 'stretch',
                          borderRadius: 2,
                          background: ev.color,
                          flexShrink: 0,
                        }} />
                      )}
                      {ev.summary && <div style={{ width: 3, flexShrink: 0 }} />}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {ev.time && (
                          <div style={{ fontSize: 10, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
                            {fmtLocal(ev.time)}
                          </div>
                        )}
                        <div style={{
                          fontSize: 11,
                          color: ev.summary ? 'var(--dim)' : ev.color,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {ev.label}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{
        marginTop: 20,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        fontSize: 12,
        alignItems: 'center',
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text)', marginRight: 4 }}>Live status</span>

        <span style={{
          padding: '2px 8px', borderRadius: 20,
          background: schedulerRunning ? '#0f2d1a' : '#2d0f0f',
          color: schedulerRunning ? '#22c55e' : '#ef4444',
          fontWeight: 600,
        }}>
          Scheduler: {schedulerRunning ? 'running' : 'stopped'}
        </span>

        <span style={{
          padding: '2px 8px', borderRadius: 20,
          background: marketOpen ? '#0f2d1a' : '#2d0f0f',
          color: marketOpen ? '#22c55e' : '#ef4444',
          fontWeight: 600,
        }}>
          Market: {marketOpen ? 'open' : 'closed'}
        </span>

        <span style={{ color: 'var(--dim)' }}>
          Last scan: <span style={{ color: 'var(--text)' }}>{timeAgo(lastRun)}</span>
        </span>

        <span style={{ color: 'var(--dim)' }}>
          Next scan: <span style={{ color: 'var(--text)' }}>{timeUntil(nextRun)}</span>
        </span>

        {marketHours && (
          <span style={{ color: 'var(--dim)', marginLeft: 'auto' }}>
            Market {marketHours.open}–{marketHours.close} {marketHours.timezone} · scan every {scanIntervalMinutes}m
          </span>
        )}
      </div>
    </div>
  )
}
