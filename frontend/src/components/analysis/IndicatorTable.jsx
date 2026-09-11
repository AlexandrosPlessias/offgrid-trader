export default function IndicatorTable({ marketData }) {
  if (!marketData?.technicals) return null
  const { technicals } = marketData
  const TFS = ['1H', '4H', '1D']
  const fmtN = v => (v != null ? Number(v).toFixed(2) : '—')

  const rows = [
    { label: 'RSI',         get: d => d?.RSI },
    { label: 'MACD',        get: d => d?.MACD?.macd },
    { label: 'MACD Signal', get: d => d?.MACD?.signal },
    { label: 'MACD Hist',   get: d => d?.MACD?.histogram },
    { label: 'EMA 20',      get: d => d?.EMA20 },
    { label: 'EMA 50',      get: d => d?.EMA50 },
    { label: 'EMA 200',     get: d => d?.EMA200 },
    { label: 'BB Upper',    get: d => d?.BollingerBands?.upper },
    { label: 'BB Lower',    get: d => d?.BollingerBands?.lower },
    { label: 'Stoch K',     get: d => d?.Stochastic?.k },
    { label: 'Stoch D',     get: d => d?.Stochastic?.d },
    { label: 'Signal',      get: d => d?.recommendation, isRec: true },
  ]

  return (
    <details className="indicator-details">
      <summary>📋 Raw indicator data (all timeframes)</summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr>
              <th>Indicator</th>
              {TFS.map(tf => <th key={tf}>{tf}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, get, isRec }) => (
              <tr key={label}>
                <td className="text-dim">{label}</td>
                {TFS.map(tf => {
                  const val = get(technicals[tf])
                  return (
                    <td key={tf}>
                      {isRec
                        ? <span className={`ind-rec ${(val ?? '').toLowerCase()}`}>
                            {val ?? '—'}
                          </span>
                        : fmtN(val)
                      }
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
