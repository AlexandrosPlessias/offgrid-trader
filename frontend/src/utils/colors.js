export const TIP_RSI = 'RSI (Relative Strength Index) measures price momentum on a 0–100 scale. Below 30 = potentially oversold (price may bounce). Above 70 = potentially overbought (price may pull back). Agreement across multiple timeframes strengthens the signal.'
export const TIP_MACD = 'MACD histogram is the difference between the fast and slow moving averages of price. Positive bar (green) = upward momentum building. Negative bar (red) = downward momentum. Bars crossing zero signal a momentum shift.'
export const TIP_EMA = 'EMAs (Exponential Moving Averages) smooth price noise. These bars show how far above (+) or below (−) the current price sits relative to each EMA. Green = price above EMA (bullish context). Red = price below EMA (bearish context).'
export const TIP_HISTORY = 'Historical daily closing price over the last 3 months. Helps you see the trend context behind the current snapshot. Volume bars below are color-coded: green = close ≥ previous day, red = close < previous day.'

export const CHART_TOOLTIP_STYLE = {
  contentStyle: { background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 11 },
  itemStyle: { color: '#e6edf3' },
  labelStyle: { color: '#8b949e' },
}
export const AXIS_TICK = { fill: '#8b949e', fontSize: 10 }

export const CONF_BAND_COLOR = {
  very_low: 'var(--red)', low: 'var(--yellow)', moderate: 'var(--dim)',
  high: 'var(--green)', very_high: 'var(--green)',
}
export const EVIDENCE_DIR_COLOR = { bullish: 'var(--green)', bearish: 'var(--red)', neutral: 'var(--dim)' }
export const RISK_SEV_COLOR = { low: 'var(--dim)', medium: 'var(--yellow)', high: 'var(--red)' }

export const SOURCE_LABEL = {
  ai:                '🤖 AI',
  rsi_extreme:       'RSI',
  macd_crossover:    'MACD cross',
  volume_spike:      'Vol ↑',
  valuation_extreme: 'P/E high',
  valuation_cheap:   'P/E low',
  macro_regime:      'Macro',
}
