export const INIT_STEPS = [
  { id: 'fetch',   label: 'Fetch market data',   status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
  { id: 'analyze', label: 'AI analysis',          status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
  { id: 'detect',  label: 'Detect opportunities', status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
]

export const STEP_META = {
  fetch: {
    icon: '📦',
    label: 'Fetch market data',
    subs: ['Price & volume', 'Technical indicators (RSI, MACD, BBands)', 'Fundamentals & news', 'Balance sheet', 'Macro context (FRED)'],
  },
  analyze: {
    icon: '🤖',
    label: 'AI analysis',
    subs: [
      'Backend pre-computes long/short candidate trade plans (ATR-based)',
      'Build structured prompt with all market context + candidate plans',
      'Call configured LLM (Ollama · Groq · Gemini · Mistral)',
      'LLM classifies setup & selects a plan_id — no price calculation',
      'Parse v2 response: decision, confidence_raw, evidence, risks',
    ],
  },
  detect: {
    icon: '🎯',
    label: 'Detect opportunities',
    subs: ['Rule checks (RSI, MACD, volume, P/E)', 'Merge & deduplicate signals', 'Macro regime confidence filter'],
  },
}

export default function AnalysisStepper({ steps }) {
  const done  = steps.filter(s => s.status === 'done').length
  const total = steps.length
  const pct   = Math.round((done / total) * 100)

  return (
    <div className="stepper">
      <div className="stepper-bar-track">
        <div className="stepper-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {steps.map((step, idx) => {
        const meta = STEP_META[step.id] || { icon: '●', label: step.label, subs: [] }
        return (
          <div key={step.id} className={`step step-v2 ${step.status}`}>
            <div className="step-left">
              <span className="step-num">{idx + 1}</span>
            </div>
            <div className="step-body">
              <div className="step-header-row">
                <span className="step-icon-lg">{meta.icon}</span>
                <span className="step-label">{meta.label}</span>
                {step.id === 'analyze' && step.status === 'done' && step.llm_model && (
                  <span
                    className="model-chip step-model-chip"
                    title={step.llm_provider ? `${step.llm_provider} · ${step.llm_model}` : step.llm_model}
                  >
                    {step.llm_provider ? `${step.llm_provider} · ` : ''}{step.llm_model}
                  </span>
                )}
                {step.elapsed != null && (
                  <span className={`step-elapsed${step.status === 'running' ? ' step-elapsed-live' : ''}`}>
                    {step.elapsed}s{step.status === 'running' ? '…' : ''}
                  </span>
                )}
                {step.retries > 0 && (
                  <span className="step-retry-badge">↺ {step.retries}</span>
                )}
                <span className={`step-badge step-badge-${step.status}`}>
                  {step.status === 'done'    ? '✓ done'
                 : step.status === 'running' ? '⟳ running'
                 : step.status === 'error'   ? '✕ error'
                 :                             'pending'}
                </span>
              </div>
              <ul className={`step-subs${step.status === 'pending' ? ' step-subs-pending' : ''}`}>
                {meta.subs.map(s => <li key={s}>{s}</li>)}
              </ul>
              {/* Scored opportunities — summary pills; full breakdown in Score Computation section */}
              {step.id === 'detect' && step.status === 'done' && step.opportunities !== null && step.opportunities?.length > 0 && (
                <div className="step-opp-pills">
                  {[...step.opportunities]
                    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
                    .map((opp, i) => {
                      const isActionable = (step.actionable ?? []).some(
                        a => a.type === opp.type && Math.abs((a.confidence ?? 0) - (opp.confidence ?? 0)) < 0.5
                      )
                      return (
                        <span key={i} className={`opp-pill ${isActionable ? 'opp-pill-ok' : 'opp-pill-sub'}`}>
                          <span className={`opp-pill-type ${opp.type}`}>{opp.type?.toUpperCase() ?? '—'}</span>
                          <span className="opp-pill-conf">{(opp.confidence ?? 0).toFixed(0)}%</span>
                          <span className="opp-pill-src">{opp.source ?? (opp.sources ?? []).join('+') ?? ''}</span>
                          <span className="opp-pill-status">{isActionable ? '✓' : '↓'}</span>
                        </span>
                      )
                    })
                  }
                </div>
              )}
              {step.id === 'detect' && step.status === 'done' && step.opportunities !== null && !step.opportunities?.length && (
                <div className="step-opp-none">no rule checks fired</div>
              )}
              {step.status === 'error' && step.msg && (
                <div className="step-msg">{step.msg}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
