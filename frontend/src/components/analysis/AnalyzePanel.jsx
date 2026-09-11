import { useState } from 'react'
import { useAnalyzeStream } from '../../hooks/useAnalyzeStream'
import AnalysisStepper from './AnalysisStepper'
import AnalysisResult from './AnalysisResult'

export default function AnalyzePanel({ onExplore }) {
  const [ticker, setTicker] = useState('')
  const { streaming, steps, result, error, run } = useAnalyzeStream()

  const handleRun = () => run(ticker)

  return (
    <section className="card analyze-card">
      <div className="card-title">On-Demand Analysis</div>
      <div className="analyze-row">
        <input
          className="ticker-input"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleRun()}
          placeholder="Ticker (e.g. NVDA)"
          maxLength={10}
          disabled={streaming}
        />
        <button
          className="btn-primary"
          onClick={handleRun}
          disabled={streaming || !ticker.trim()}
        >
          {streaming ? 'Analyzing…' : 'Run Analysis'}
        </button>
      </div>
      {error && <div className="error-msg">{error}</div>}
      {steps && <AnalysisStepper steps={steps} />}
      {result && <AnalysisResult result={result} onExplore={onExplore} />}
    </section>
  )
}
