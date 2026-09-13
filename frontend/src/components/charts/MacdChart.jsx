import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts'
import { CHART_TOOLTIP_STYLE, AXIS_TICK } from '../../utils/colors'

export default function MacdChart({ technicals }) {
  const TFS = ['1H', '4H', '1D']
  const data = TFS
    .map(tf => ({ name: tf, hist: technicals?.[tf]?.MACD?.histogram ?? null }))
    .filter(d => d.hist != null)

  if (data.length === 0) return <div className="chart-empty">No MACD data</div>

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} barCategoryGap="30%">
        <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} />
        <Tooltip {...CHART_TOOLTIP_STYLE} formatter={v => [v?.toFixed(4), 'MACD Hist']} />
        <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
        <Bar dataKey="hist" radius={[3, 3, 0, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.hist >= 0 ? '#3fb950' : '#f85149'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
