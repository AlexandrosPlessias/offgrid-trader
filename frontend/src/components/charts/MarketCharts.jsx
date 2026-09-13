import InfoTip from '../shared/InfoTip'
import RsiChart from './RsiChart'
import MacdChart from './MacdChart'
import EmaChart from './EmaChart'
import { TIP_RSI, TIP_MACD, TIP_EMA } from '../../utils/colors'

export default function MarketCharts({ marketData }) {
  if (!marketData?.technicals) return null
  const price = marketData.price?.current

  return (
    <div className="charts-grid">
      <div className="chart-card">
        <div className="chart-title">RSI <InfoTip text={TIP_RSI} /></div>
        <RsiChart technicals={marketData.technicals} />
      </div>
      <div className="chart-card">
        <div className="chart-title">MACD Histogram <InfoTip text={TIP_MACD} /></div>
        <MacdChart technicals={marketData.technicals} />
      </div>
      <div className="chart-card">
        <div className="chart-title">Price vs EMAs <InfoTip text={TIP_EMA} /></div>
        <EmaChart price={price} technicals={marketData.technicals} />
      </div>
    </div>
  )
}
