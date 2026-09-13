import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip } from 'recharts'
import { CHART_TOOLTIP_STYLE } from '../../utils/colors'
import { fmtMarketCap } from '../../utils/fmt'

/**
 * Horizontal bar chart: Assets / Liabilities / Equity side-by-side.
 * Uses a fixed 320px width to match the indicator charts' style.
 */
export default function BalanceSheetChart({ bs }) {
  const FILLS = ['#22c55e', '#ef4444', '#3b82f6']
  const data = [
    { name: 'Assets',      value: bs.total_assets },
    { name: 'Liabilities', value: bs.total_liabilities },
    { name: 'Equity',      value: bs.stockholders_equity },
  ].filter(d => d.value != null)
  if (!data.length) return null
  return (
    <BarChart width={320} height={90} data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
      <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#8b949e' }} />
      <YAxis hide />
      <Tooltip
        {...CHART_TOOLTIP_STYLE}
        formatter={(v, name, props) => [fmtMarketCap(v), props.payload.name]}
      />
      <Bar dataKey="value" radius={[3, 3, 0, 0]}>
        {data.map((_, i) => <Cell key={i} fill={FILLS[i % FILLS.length]} />)}
      </Bar>
    </BarChart>
  )
}
