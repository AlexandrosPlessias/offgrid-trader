import { useState, useEffect, useCallback } from 'react'
import { API, readSSEStream } from '../utils/api'

const INIT_STEPS = [
  { id: 'fetch',   label: 'Fetch market data',   status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
  { id: 'analyze', label: 'AI analysis',          status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
  { id: 'detect',  label: 'Detect opportunities', status: 'pending', elapsed: null, msg: null, retries: 0, startedAt: null },
]

export function useAnalyzeStream() {
  const [streaming, setStreaming] = useState(false)
  const [steps, setSteps] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const run = useCallback(async (ticker) => {
    const t = ticker.trim().toUpperCase()
    if (!t) return
    setStreaming(true)
    setResult(null)
    setError(null)
    setSteps(INIT_STEPS.map(s => ({ ...s })))

    try {
      const SKILL_TO_STEP = { fetch_data: 'fetch', ai_analysis: 'analyze', opportunity_detect: 'detect' }
      for await (const evt of readSSEStream(`${API}/analyze/stream`, { ticker: t, send_alerts: false })) {
        if (evt.type === 'step') {
          setSteps(prev => prev.map(s =>
            s.id === evt.step
              ? {
                  ...s,
                  status: evt.status,
                  elapsed: evt.elapsed_ms != null ? (evt.elapsed_ms / 1000).toFixed(1) : s.elapsed,
                  msg: evt.msg ?? s.msg,
                  startedAt: evt.status === 'running' ? Date.now() : null,
                }
              : s
          ))
        } else if (evt.type === 'retry') {
          const stepId = SKILL_TO_STEP[evt.skill] ?? evt.skill
          setSteps(prev => prev.map(s =>
            s.id === stepId ? { ...s, retries: (s.retries || 0) + 1 } : s
          ))
        } else if (evt.type === 'result') {
          setResult(evt)
          // Backfill the detect step with scored opportunities and the analyze step
          // with the model that actually ran — no extra SSE event needed.
          setSteps(prev => prev && prev.map(s => {
            if (s.id === 'detect' && evt.opportunities?.length) {
              return { ...s, opportunities: evt.opportunities, actionable: evt.actionable ?? [] }
            }
            if (s.id === 'analyze' && evt.analysis) {
              return {
                ...s,
                llm_model:    evt.analysis.llm_model    ?? null,
                llm_provider: evt.analysis.llm_provider ?? null,
              }
            }
            return s
          }))
        }
      }
    } catch (e) {
      setError(e.message)
      setSteps(prev => prev && prev.map(s => ({
        ...s,
        status: s.status === 'running' ? 'error' : s.status,
      })))
    } finally {
      setStreaming(false)
    }
  }, [])

  // Tick elapsed display for any step that is currently running.
  useEffect(() => {
    if (!streaming || !steps) return
    const hasRunning = steps.some(s => s.status === 'running' && s.startedAt)
    if (!hasRunning) return
    const id = setInterval(() => {
      setSteps(prev => prev && prev.map(s =>
        s.status === 'running' && s.startedAt
          ? { ...s, elapsed: ((Date.now() - s.startedAt) / 1000).toFixed(1) }
          : s
      ))
    }, 200)
    return () => clearInterval(id)
  }, [streaming, steps])

  return { streaming, steps, result, error, run }
}
