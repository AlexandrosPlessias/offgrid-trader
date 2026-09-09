import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts'
import { CHART_TOOLTIP_STYLE, AXIS_TICK } from '../../utils/colors'

export default function RsiChart({ technicals }) {
  const TFS = ['1H', '4H', '1D']
  const data = TFS
    .map(tf => ({ name: tf, rsi: technicals?.[tf]?.RSI ?? null }))
    .filter(d => d.rsi != null)

  if (data.length === 0) return <div className="chart-empty">No RSI data</div>

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} barCategoryGap="30%">
        <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tick={AXIS_TICK} axisLine={false} tickLine={false} width={28} />
        <Tooltip {...CHART_TOOLTIP_STYLE} formatter={v => [v?.toFixed(1), 'RSI']} />
        <ReferenceLine y={30} stroke="#3fb950" strokeDasharray="3 3" strokeWidth={1} />
        <ReferenceLine y={70} stroke="#f85149" strokeDasharray="3 3" strokeWidth={1} />
        <Bar dataKey="rsi" radius={[3, 3, 0, 0]}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.rsi < 30 ? '#3fb950' : entry.rsi > 70 ? '#f85149' : '#58a6ff'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
