/**
 * PriceSlider — compact stop-to-target proximity bar.
 *
 * Works for both long and short positions:
 *   Long:  stop < entry < target  — left=bad (stop), right=good (target)
 *   Short: target < entry < stop  — left=bad (stop), right=good (target)
 *          detected automatically when target < stop
 *
 * Props:
 *   stop    {number}  stop-loss price
 *   target  {number}  take-profit price
 *   current {number}  current price (open position) or exit/fill price (closed)
 *   width   {number?} bar width in px (default 120)
 */
export default function PriceSlider({ stop, target, current, width = 120 }) {
  if (stop == null || target == null || current == null) return null
  const s = Number(stop)
  const t = Number(target)
  const c = Number(current)
  if (!s || !t || !c || s === t) return null

  const isShort = t < s  // short: target below stop

  // pct = 0 at stop (bad), 1 at target (good) — direction-aware
  const pct = isShort
    ? Math.max(0, Math.min(1, (s - c) / (s - t)))   // short: lower = better
    : Math.max(0, Math.min(1, (c - s) / (t - s)))   // long:  higher = better

  // Colour: red ≤ 30 %, green ≥ 70 %, amber in middle
  const markerColor = pct <= 0.30 ? '#f87171'
    : pct >= 0.70 ? '#34d399'
    : '#fbbf24'

  const barH = 4
  const markerR = 5
  const totalH = markerR * 2 + 2

  const tooltip = isShort
    ? `Stop $${s.toFixed(2)} ← Current $${c.toFixed(2)} ← Target $${t.toFixed(2)} (short)`
    : `Stop $${s.toFixed(2)} → Current $${c.toFixed(2)} → Target $${t.toFixed(2)}`

  return (
    <div
      title={tooltip}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'middle' }}
    >
      <span style={{ fontSize: 9, color: '#f87171', lineHeight: 1 }}>📉</span>

      <svg width={width} height={totalH} style={{ overflow: 'visible', display: 'block' }}>
        <defs>
          <linearGradient id="slider-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%"   stopColor="#f87171" stopOpacity={0.35} />
            <stop offset="50%"  stopColor="#fbbf24" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <rect
          x={0} y={(totalH - barH) / 2}
          width={width} height={barH}
          rx={barH / 2}
          fill="url(#slider-grad)"
        />
        <rect
          x={0} y={(totalH - barH) / 2}
          width={pct * width} height={barH}
          rx={barH / 2}
          fill={markerColor} fillOpacity={0.6}
        />
        <rect
          x={width / 2 - 0.5} y={(totalH - barH) / 2 - 2}
          width={1} height={barH + 4}
          fill="var(--border)"
        />
        <circle
          cx={pct * width} cy={totalH / 2}
          r={markerR}
          fill={markerColor}
          stroke="var(--bg)" strokeWidth={1.5}
        />
      </svg>

      <span style={{ fontSize: 9, color: '#34d399', lineHeight: 1 }}>🎯</span>
    </div>
  )
}
