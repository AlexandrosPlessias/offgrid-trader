import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts'
import { CHART_TOOLTIP_STYLE, AXIS_TICK } from '../../utils/colors'

export default function EmaChart({ price, technicals }) {
  const tf = technicals?.['1D']
  const ema20  = tf?.EMA20  ?? null
  const ema50  = tf?.EMA50  ?? null
  const ema200 = tf?.EMA200 ?? null

  if (!price || (!ema20 && !ema50 && !ema200)) {
    return <div className="chart-empty">No EMA data</div>
  }

  const pct = ema => ema ? parseFloat(((price - ema) / ema * 100).toFixed(2)) : null

  const data = [
    { name: 'vs EMA20',  value: pct(ema20)  },
    { name: 'vs EMA50',  value: pct(ema50)  },
    { name: 'vs EMA200', value: pct(ema200) },
  ].filter(d => d.value != null)

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} barCategoryGap="30%">
        <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={36}
               tickFormatter={v => `${v}%`} />
        <Tooltip
          {...CHART_TOOLTIP_STYLE}
          formatter={v => [`${v > 0 ? '+' : ''}${v}%`, 'Price vs EMA']}
        />
        <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
        <Bar dataKey="value" radius={[3, 3, 0, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.value >= 0 ? '#3fb950' : '#f85149'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
