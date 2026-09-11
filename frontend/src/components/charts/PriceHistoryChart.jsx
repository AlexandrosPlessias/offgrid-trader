import { useState, useCallback } from 'react'
import {
  ResponsiveContainer,
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip,
  BarChart, Bar, Cell,
} from 'recharts'
import InfoTip from '../shared/InfoTip'
import { API, getAuthHeaders } from '../../utils/api'
import { CHART_TOOLTIP_STYLE, AXIS_TICK, TIP_HISTORY } from '../../utils/colors'

export default function PriceHistoryChart({ ticker }) {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState(null)
  const [histError, setHistError] = useState(null)

  const load = useCallback(async () => {
    if (!ticker) return
    setLoading(true)
    setHistError(null)
    try {
      const res = await fetch(`${API}/market-data/${ticker}/history`, { headers: getAuthHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setHistory(data.candles ?? [])
    } catch (e) {
      setHistError(e.message)
    } finally {
      setLoading(false)
    }
  }, [ticker])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    if (next && !history) load()
  }

  return (
    <div className="history-chart-section">
      <div className="history-chart-header">
        <span className="chart-title" style={{ margin: 0 }}>
          📈 Price History (3 months) <InfoTip text={TIP_HISTORY} />
        </span>
        <label className="history-toggle-label">
          <input
            type="checkbox"
            className="history-toggle-input"
            checked={enabled}
            onChange={toggle}
          />
          <span className={`history-toggle-track ${enabled ? 'on' : ''}`}>
            <span className="history-toggle-thumb" />
          </span>
          <span className="history-toggle-text">{enabled ? 'on' : 'off'}</span>
        </label>
      </div>

      {enabled && (
        <div className="history-chart-body">
          {loading && <div className="chart-loading">Loading history…</div>}
          {histError && <div className="error-msg">{histError}</div>}
          {history && history.length > 0 && (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#58a6ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#58a6ff" stopOpacity={0}   />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    interval={Math.max(1, Math.floor((history.length) / 5))}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    width={54}
                    tickFormatter={v => `$${v.toFixed(0)}`}
                  />
                  <Tooltip
                    {...CHART_TOOLTIP_STYLE}
                    formatter={v => [`$${v?.toFixed(2)}`, 'Close']}
                  />
                  <Area
                    type="monotone"
                    dataKey="close"
                    stroke="#58a6ff"
                    strokeWidth={1.5}
                    fill="url(#priceGrad)"
                    dot={false}
                    activeDot={{ r: 3, fill: '#58a6ff' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
              <ResponsiveContainer width="100%" height={48}>
                <BarChart data={history} margin={{ top: 2, right: 8, left: 0, bottom: 0 }} barCategoryGap="0%">
                  <XAxis dataKey="date" hide />
                  <YAxis hide />
                  <Tooltip
                    {...CHART_TOOLTIP_STYLE}
                    formatter={v => [v?.toLocaleString(), 'Volume']}
                  />
                  <Bar dataKey="volume" radius={0}>
                    {history.map((entry, i) => (
                      <Cell key={i} fill={entry.up ? '#3fb95066' : '#f8514966'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
          {history && history.length === 0 && (
            <div className="text-dim" style={{ padding: '12px 0' }}>No history data available.</div>
          )}
        </div>
      )}
    </div>
  )
}
