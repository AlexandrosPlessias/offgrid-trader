import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ResponsiveContainer,
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine,
} from 'recharts'
import { API, getAuthHeaders } from '../utils/api'
import { fmtPct, fmtR, fmtNum, fmtTokens } from '../utils/fmt'
import { CHART_TOOLTIP_STYLE, AXIS_TICK } from '../utils/colors'

const BT_PRESETS = [
  { label: '30D', days: 30 },
  { label: '3M', days: 91 },
  { label: '6M', days: 182 },
  { label: '1Y', days: 365 },
  { label: '2Y', days: 730 },
]

const BT_COMPARATOR_COLORS = ['#58a6ff','#34d399','#fbbf24','#f87171','#a855f7','#22d3ee']

export default function BacktestPage({ wl, usage }) {
  // ── Form state ────────────────────────────────────────────────────────────
  const watchlistTickers = (wl?.watchlist ?? wl?.tickers ?? [])

  // Distinct tickers from active signals + past backtest runs — for quick-add
  const [signalTickers, setSignalTickers] = useState([])
  useEffect(() => {
    fetch(`${API}/signals?limit=500`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => {
        const fromSignals = (d.signals ?? []).map(s => s.ticker).filter(Boolean)
        setSignalTickers(prev => {
          const combined = [...new Set([...fromSignals, ...prev])].sort()
          return combined
        })
      })
      .catch(() => {})
  }, [])
  const [selTickers, setSelTickers] = useState([])
  const [addTickerInput, setAddTickerInput] = useState('')
  const [preset, setPreset] = useState('3M')
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0,10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0,10))
  const [confFloor, setConfFloor] = useState(75)
  const [maxHold, setMaxHold]       = useState(10)
  const [scanInterval, setScanInterval] = useState(1440)  // minutes; 1440 = end-of-day
  const [useLlm, setUseLlm]         = useState(false)
  const [isOos, setIsOos]           = useState(false)
  const [atrMult, setAtrMult]     = useState(2.0)
  const [rrRatio, setRrRatio]     = useState(2.0)
  const [rpm, setRpm]             = useState('')
  const [initBalance, setInitBalance] = useState(10000)
  const [posSizePct, setPosSizePct] = useState(10)  // % of balance per trade

  // ── Saved param profiles (DB-backed) ─────────────────────────────────────
  const [profiles, setProfiles] = useState([])
  const [profileNameInput, setProfileNameInput] = useState('')
  const [showProfileSave, setShowProfileSave] = useState(false)

  const _reloadProfiles = useCallback(() => {
    fetch(`${API}/backtest/profiles`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => setProfiles(d.profiles ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => { _reloadProfiles() }, [_reloadProfiles])

  const _saveProfile = async () => {
    const name = profileNameInput.trim()
    if (!name) return
    await fetch(`${API}/backtest/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        name,
        params: {
          tickers: selTickers,
          confFloor, maxHold, scanInterval, useLlm, isOos,
          atrMult, rrRatio, rpm, initBalance, posSizePct, cashoutR,
        },
      }),
    }).catch(() => {})
    setProfileNameInput('')
    setShowProfileSave(false)
    _reloadProfiles()
  }

  const _loadProfile = (p) => {
    const q = p.params
    if (q.tickers?.length) setSelTickers(q.tickers)
    if (q.confFloor != null) setConfFloor(q.confFloor)
    if (q.maxHold   != null) setMaxHold(q.maxHold)
    if (q.scanInterval != null) setScanInterval(q.scanInterval)
    if (q.useLlm   != null) setUseLlm(q.useLlm)
    if (q.isOos    != null) setIsOos(q.isOos)
    if (q.atrMult  != null) setAtrMult(q.atrMult)
    if (q.rrRatio  != null) setRrRatio(q.rrRatio)
    if (q.rpm      != null) setRpm(q.rpm)
    if (q.initBalance != null) setInitBalance(q.initBalance)
    if (q.posSizePct  != null) setPosSizePct(q.posSizePct)
    setCashoutR(q.cashoutR ?? null)
  }

  const _deleteProfile = async (id) => {
    await fetch(`${API}/backtest/profiles/${id}`, {
      method: 'DELETE', headers: getAuthHeaders(),
    }).catch(() => {})
    _reloadProfiles()
  }
  const [cashoutR, setCashoutR] = useState(null)     // null = disabled; number = R level

  // ── Run state ─────────────────────────────────────────────────────────────
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [notices, setNotices]   = useState([])   // fallback / quota_stop events
  const [report, setReport]     = useState(null) // current run result
  const [runError, setRunError] = useState(null)

  // ── Results floor slider (client-side re-filter) ──────────────────────────
  const [liveFloor, setLiveFloor] = useState(75)

  // ── Loaded past run persistence ───────────────────────────────────────────
  // Track which past run is currently open so the row stays highlighted and
  // the run is automatically reloaded after a page refresh.
  const [loadedRunId, setLoadedRunId] = useState(() => {
    try { return parseInt(localStorage.getItem('bt_loaded_run_id') || '', 10) || null }
    catch { return null }
  })
  const loadRun = useCallback((runId) => {
    fetch(`${API}/backtest/${runId}`, { headers: getAuthHeaders() })
      .then(res => res.json())
      .then(d => {
        setReport(d)
        setLiveFloor(d.confidence_floor ?? 75)
        setAiReview(null); setAiReviewError(null)
        setFloorSuggest(null); setFloorSuggestError(null)
        setLoadedRunId(runId)
        try { localStorage.setItem('bt_loaded_run_id', String(runId)) } catch {}
      })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // On mount, if a run was previously loaded restore it (once past runs are available).
  const _restoredRef = useRef(false)

  // ── Past runs ─────────────────────────────────────────────────────────────
  const { data: pastRunsData, reload: reloadRuns } = usePolling('/backtest', 30_000)
  const pastRuns = pastRunsData?.runs ?? []

  // Merge past-run tickers into signalTickers so users can quick-add tickers
  // they've previously backtested even when the signals table is empty.
  useEffect(() => {
    if (!pastRuns.length) return
    const fromRuns = pastRuns.flatMap(r => r.tickers ?? []).filter(Boolean)
    setSignalTickers(prev => [...new Set([...fromRuns, ...prev])].sort())
    // Restore the last-loaded run once the list is available.
    if (!_restoredRef.current && loadedRunId && !report) {
      const exists = pastRuns.some(r => r.id === loadedRunId)
      if (exists) { _restoredRef.current = true; loadRun(loadedRunId) }
    }
  }, [pastRuns.length])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Comparator ────────────────────────────────────────────────────────────
  const [compareSel, setCompareSel] = useState(new Set())
  const [compareData, setCompareData] = useState({})   // run_id -> run dict

  // Reset AI compare result whenever the selection changes.
  useEffect(() => { setAiCompare(null); setAiCompareError(null) }, [compareSel])

  // ── Pre-flight LLM notifier ───────────────────────────────────────────────
  const [quotaInfo, setQuotaInfo] = useState(null)
  useEffect(() => {
    if (!useLlm) return
    fetch(`${API}/provider/quota`, { headers: getAuthHeaders() }).then(r => r.json()).then(setQuotaInfo).catch(() => {})
  }, [useLlm])

  // ── Feature 2: model/provider change detection (no refresh needed) ────────
  const knownModelRef = useRef(null)
  const [modelBanner, setModelBanner] = useState(null)  // { from, to } when model changed
  useEffect(() => {
    const poll = async () => {
      try {
        const h = await fetch(`${API}/health`).then(r => r.json())
        const provider  = h?.llm_provider ?? null
        const modelName = h?.llm_model ?? h?.ollama_model ?? null
        if (!provider || !modelName) return
        const key = `${provider}::${modelName}`
        if (knownModelRef.current === null) { knownModelRef.current = key; return }
        if (knownModelRef.current !== key) {
          const prev = knownModelRef.current.replace('::', ' · ')
          const next = key.replace('::', ' · ')
          setModelBanner({ from: prev, to: next })
          knownModelRef.current = key
        }
      } catch {}
    }
    poll()
    const id = setInterval(poll, 20_000)
    return () => clearInterval(id)
  }, [])

  // ── Feature 3: tokens consumed during a run ───────────────────────────────
  const [runTokenDelta, setRunTokenDelta] = useState(null)

  // ── Feature 4: AI review of run results ──────────────────────────────────
  const [aiReview, setAiReview]               = useState(null)
  const [aiReviewLoading, setAiReviewLoading] = useState(false)
  const [aiReviewError, setAiReviewError]     = useState(null)

  // ── Feature 5: Experiment Advisor ────────────────────────────────────────
  const [floorSuggest,        setFloorSuggest]        = useState(null)
  const [floorSuggestLoading, setFloorSuggestLoading] = useState(false)
  const [floorSuggestError,   setFloorSuggestError]   = useState(null)

  // ── Feature 6: AI run comparator ─────────────────────────────────────────
  const [aiCompare,        setAiCompare]        = useState(null)
  const [aiCompareLoading, setAiCompareLoading] = useState(false)
  const [aiCompareError,   setAiCompareError]   = useState(null)

  const estDays = (() => {
    if (!startDate || !endDate) return 0
    const ms = new Date(endDate) - new Date(startDate)
    return Math.max(0, Math.round(ms / 86400000 * 5 / 7))
  })()
  // Scans per trading day depends on scan interval.
  // NYSE session = 390 min; ceil(390 / interval) + 1 to include both endpoints.
  const scansPerDay = scanInterval >= 1440 ? 1 : Math.ceil(390 / scanInterval) + 1
  const estRequests = selTickers.length * estDays * scansPerDay
  const avgTokens = (() => {
    // Prefer analysis_log history; fall back to backtest run averages when no live scans yet
    if (usage && (usage.total_rows ?? 0) > 0) {
      return Math.round(
        (usage.total_prompt_tokens + usage.total_completion_tokens) / Math.max(usage.total_rows, 1)
      )
    }
    const runs = pastRunsData?.runs ?? []
    const btCalls = runs.reduce((s, r) => s + (r.llm_calls ?? 0), 0)
    const btTokens = runs.reduce((s, r) => s + (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0), 0)
    if (btCalls > 0) return Math.round(btTokens / btCalls)
    return 0
  })()
  const estTokens   = estRequests * avgTokens
  const rpmCap      = parseInt(rpm) || null
  const estMinutes  = rpmCap ? Math.ceil(estRequests / rpmCap) : null
  const provLimits  = quotaInfo?.rate_limits ?? quotaInfo?.free_tier_limits?.[Object.keys(quotaInfo?.free_tier_limits ?? {})[0]] ?? null
  const overRpd     = provLimits?.rpd != null && estRequests > provLimits.rpd
  const overTpm     = provLimits?.tpm != null && rpmCap && (rpmCap * avgTokens) > provLimits.tpm

  // ── Ticker add / remove ────────────────────────────────────────────────────
  const addTicker = (t) => {
    const u = t.trim().toUpperCase()
    if (u && !selTickers.includes(u)) setSelTickers(s => [...s, u])
    setAddTickerInput('')
  }
  const removeTicker = (t) => setSelTickers(s => s.filter(x => x !== t))

  // ── Date preset ───────────────────────────────────────────────────────────
  const applyPreset = (p) => {
    setPreset(p.label)
    const end = new Date()
    const start = new Date(); start.setDate(start.getDate() - p.days)
    setStartDate(start.toISOString().slice(0,10))
    setEndDate(end.toISOString().slice(0,10))
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  const runBacktest = async () => {
    if (!selTickers.length) return
    setRunning(true); setProgress(0); setProgressLabel(''); setNotices([]); setReport(null); setRunError(null)
    setRunTokenDelta(null); setAiReview(null); setAiReviewError(null)
    setFloorSuggest(null); setFloorSuggestError(null)
    const body = {
      tickers: selTickers, start_date: startDate, end_date: endDate,
      initial_balance: parseFloat(initBalance) || 10000,
      position_size_pct: posSizePct / 100,
      cashout_r: cashoutR,
      confidence_floor: confFloor, max_hold_days: parseInt(maxHold) || 10,
      use_llm: useLlm, atr_multiple: parseFloat(atrMult) || 1.5,
      reward_risk: parseFloat(rrRatio) || 2.0,
      requests_per_minute: rpmCap,
      scan_interval_minutes: scanInterval,
      is_out_of_sample: isOos,
    }
    try {
      for await (const evt of readSSEStream(`${API}/backtest/stream`, body)) {
        if (evt.type === 'progress') {
          setProgress(evt.pct ?? 0)
          setProgressLabel(evt.ticker + (evt.day ? ' · ' + evt.day : ''))
        } else if (evt.type === 'fallback') {
          setNotices(n => [...n, { kind: 'fallback', msg: `Provider switched: ${evt.from} → ${evt.to} (${evt.reason ?? 'quota/error'})` }])
        } else if (evt.type === 'quota_stop') {
          setNotices(n => [...n, { kind: 'quota', msg: `Quota exhausted on ${evt.ticker} ${evt.day}: ${evt.msg}. Partial results saved.` }])
        } else if (evt.type === 'result') {
          setReport(evt.report)
          setLiveFloor(confFloor)
          reloadRuns()
          // Feature 3: token counts come directly from the report (accumulated in run_backtest)
          const pt  = evt.report?.llm_prompt_tokens ?? 0
          const ct  = evt.report?.llm_completion_tokens ?? 0
          const lc  = evt.report?.llm_calls ?? 0
          if (pt + ct > 0 || lc > 0) setRunTokenDelta({ calls: lc, prompt: pt, completion: ct, total: pt + ct })
        } else if (evt.type === 'error') {
          setRunError(evt.msg ?? 'Backtest failed.')
        }
      }
    } catch (e) {
      setRunError(e.message ?? 'Stream error.')
    } finally {
      setRunning(false); setProgress(100)
    }
  }

  // ── Live floor filtering ──────────────────────────────────────────────────
  const filteredTrades = report?.trades?.filter(t => (t.confidence ?? 0) >= liveFloor) ?? []

  // ── Dollar P&L helpers (requires wallet to be present) ───────────────────
  const walletPosSz = report?.metrics?.wallet?.position_size ?? 0
  const tradeDollarPnl = (t) => {
    if (!walletPosSz) return null
    const entry = t.entry || 1
    const stop = t.stop
    const riskFrac = stop != null && entry ? Math.abs(entry - stop) / entry : 0.02
    return walletPosSz * riskFrac * (t.r_multiple ?? 0)
  }
  // Per-ticker dollar P&L map: { AAPL: 312.5, MSFT: -45.2, ... }
  const perTickerDollarPnl = (() => {
    if (!walletPosSz) return {}
    const map = {}
    filteredTrades.forEach(t => {
      if (t.r_multiple == null || !t.exit_date) return  // only closed trades
      const pnl = tradeDollarPnl(t)
      if (pnl == null) return
      map[t.ticker] = (map[t.ticker] ?? 0) + pnl
    })
    return map
  })()

  const liveMetrics    = (() => {
    if (!report?.metrics?.floor_sweep) return report?.metrics ?? null
    const entry = report.metrics.floor_sweep.find(e => e.floor === Math.round(liveFloor / 5) * 5) ?? null
    // Full recompute happens server-side; for live slider, show counts from sweep + base metrics at initial floor
    return { ...(report.metrics), ...entry }
  })()
  const cumR = (() => {
    if (!report?.trades) return []
    const sorted = [...filteredTrades].sort((a,b) => (a.signal_date??'').localeCompare(b.signal_date??''))
    let sum = 0
    return sorted.map(t => { sum += t.r_multiple ?? 0; return { date: t.signal_date?.slice(5), r: +sum.toFixed(3) } })
  })()

  // ── Comparator ────────────────────────────────────────────────────────────
  const toggleCompare = async (runId) => {
    const next = new Set(compareSel)
    if (next.has(runId)) { next.delete(runId) }
    else {
      next.add(runId)
      if (!compareData[runId]) {
        const data = await fetch(`${API}/backtest/${runId}`, { headers: getAuthHeaders() }).then(r => r.json()).catch(() => null)
        if (data) setCompareData(prev => ({...prev, [runId]: data}))
      }
    }
    setCompareSel(next)
  }

  const compareRuns = [...compareSel].map(id => compareData[id]).filter(Boolean)

  const compareChartData = (() => {
    if (!compareRuns.length) return []
    const maxLen = Math.max(...compareRuns.map(r => (r.trades?.length ?? 0)))
    return Array.from({ length: maxLen }, (_, i) => {
      const pt = { i }
      compareRuns.forEach((r, ri) => {
        const trades = [...(r.trades ?? [])].sort((a,b) => (a.signal_date??'').localeCompare(b.signal_date??''))
        let sum = 0
        for (let j = 0; j <= i && j < trades.length; j++) sum += trades[j].r_multiple ?? 0
        pt[`run_${r.id}`] = i < trades.length ? +sum.toFixed(3) : undefined
      })
      return pt
    })
  })()

  // $ equity curve chart data — merge dollar_equity_curve arrays across runs on date union
  const compareDollarChartData = (() => {
    const runsWithWallet = compareRuns.filter(r => r.metrics?.wallet?.dollar_equity_curve?.length)
    if (runsWithWallet.length < 1) return []
    // Collect all dates across runs
    const dateSet = new Set()
    runsWithWallet.forEach(r => r.metrics.wallet.dollar_equity_curve.forEach(p => { if (p.date) dateSet.add(p.date) }))
    const dates = [...dateSet].sort()
    return dates.map(date => {
      const pt = { date: date.slice(5) }
      runsWithWallet.forEach(r => {
        const pts = r.metrics.wallet.dollar_equity_curve
        // Forward-fill: last known equity up to this date
        let val = null
        for (const p of pts) { if (p.date <= date && p.equity != null) val = p.equity }
        if (val != null) pt[`run_${r.id}`] = val
      })
      return pt
    })
  })()

  const deleteRun = async (runId) => {
    await fetch(`${API}/backtest/${runId}`, { method: 'DELETE', headers: getAuthHeaders() })
    reloadRuns()
    setCompareSel(s => { const n = new Set(s); n.delete(runId); return n })
  }

  // Feature 4: request an AI verdict on the currently loaded report
  // Fresh runs have report.run_id (from backtest.py); past runs loaded via GET /backtest/{id}
  // have report.id (DB column name). Accept either.
  const reportRunId = report?.run_id ?? report?.id ?? null
  const runAiReview = async () => {
    if (!reportRunId) return
    setAiReviewLoading(true); setAiReview(null); setAiReviewError(null)
    try {
      const res = await fetch(`${API}/backtest/${reportRunId}/review`, { method: 'POST', headers: getAuthHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setAiReview(await res.json())
    } catch (e) {
      setAiReviewError(e.message ?? 'Review failed.')
    } finally {
      setAiReviewLoading(false)
    }
  }

  const runFloorSuggest = async () => {
    if (!reportRunId) return
    setFloorSuggestLoading(true); setFloorSuggestError(null)
    try {
      const res = await fetch(`${API}/backtest/${reportRunId}/experiment-advisor`, { method: 'POST', headers: getAuthHeaders() })
      if (!res.ok) throw new Error(await res.text())
      setFloorSuggest(await res.json())
    } catch (e) { setFloorSuggestError(e.message) }
    finally { setFloorSuggestLoading(false) }
  }

  const runAiCompare = async () => {
    if (compareSel.size < 2) return
    setAiCompareLoading(true); setAiCompareError(null)
    try {
      const res = await fetch(`${API}/backtest/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ run_ids: [...compareSel] }),
      })
      if (!res.ok) throw new Error(await res.text())
      setAiCompare(await res.json())
    } catch (e) { setAiCompareError(e.message) }
    finally { setAiCompareLoading(false) }
  }

  const cloneRunParams = (run, flipLlm = false) => {
    setSelTickers(run.tickers ?? [])
    setStartDate(run.start_date ?? '')
    setEndDate(run.end_date ?? '')
    setConfFloor(run.confidence_floor ?? 75)
    setMaxHold(run.max_hold_days ?? 10)
    setUseLlm(flipLlm ? run.signal_mode !== 'llm' : run.signal_mode === 'llm')
    setIsOos(run.is_out_of_sample ?? false)
    setAtrMult(run.atr_multiple ?? 2.0)
    setRrRatio(run.reward_risk ?? 2.0)
    setRpm(run.requests_per_minute ?? '')
    setScanInterval(run.scan_interval_minutes ?? 1440)
    // Restore position size from stored wallet metrics if available
    const storedPos = run.metrics?.wallet?.position_size_pct
    if (storedPos != null) setPosSizePct(Math.round(storedPos * 100))
    // Restore cashout_r from stored metrics (it lives at top-level of metrics or wallet)
    setCashoutR(run.metrics?.cashout_r ?? null)
    document.querySelector('.bt-params-section')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="explorer-page">

      {/* ── Model-change banner (Feature 2) ──────────────────────────────────── */}
      {modelBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
          background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)',
          borderRadius: 8, fontSize: 13, marginBottom: 12,
        }}>
          <span>🔄 LLM model changed: <strong>{modelBanner.from}</strong> → <strong>{modelBanner.to}</strong></span>
          <button className="btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                  onClick={() => setModelBanner(null)}>Dismiss</button>
        </div>
      )}

      {/* ── Token usage summary (Feature 1) ──────────────────────────────────── */}
      {/* Computed from backtest run records, not analysis_log, so every LLM     */}
      {/* backtest call is reflected here even if no live signal scans were done. */}
      {(() => {
        const runs = pastRunsData?.runs ?? []
        const todayIso = new Date().toISOString().slice(0, 10)
        const btTotalPt  = runs.reduce((s, r) => s + (r.llm_prompt_tokens     ?? 0), 0)
        const btTotalCt  = runs.reduce((s, r) => s + (r.llm_completion_tokens ?? 0), 0)
        const btTotalCalls = runs.reduce((s, r) => s + (r.llm_calls           ?? 0), 0)
        const btTodayTokens = runs
          .filter(r => (r.created_at ?? '').slice(0, 10) === todayIso)
          .reduce((s, r) => s + (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0), 0)
        return (
          <div className="usage-summary-row" style={{ marginBottom: 16 }}>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Today</span>
              <span className="usage-stat-value">{btTodayTokens.toLocaleString()}</span>
              <span className="usage-stat-sub">backtest tokens today</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Total tokens</span>
              <span className="usage-stat-value">{(btTotalPt + btTotalCt).toLocaleString()}</span>
              <span className="usage-stat-sub">all backtest runs</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Prompt</span>
              <span className="usage-stat-value">{btTotalPt.toLocaleString()}</span>
              <span className="usage-stat-sub">input tokens</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Completion</span>
              <span className="usage-stat-value">{btTotalCt.toLocaleString()}</span>
              <span className="usage-stat-sub">output tokens</span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">LLM calls</span>
              <span className="usage-stat-value">{btTotalCalls.toLocaleString()}</span>
              <span className="usage-stat-sub">across {runs.filter(r => r.llm_calls > 0).length} run{runs.filter(r => r.llm_calls > 0).length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        )
      })()}

      {/* ── Section 1: Parameters ──────────────────────────────────────────── */}
      <div className="explorer-section bt-params-section">
        <div className="section-header">
          <span className="section-badge">1</span>
          <span className="section-label">Parameters</span>
          <span className="section-desc">Configure and run a backtest</span>
        </div>

        {/* Ticker multiselect */}
        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label className="settings-label">Tickers</label>
          <div className="chip-list">
            {selTickers.map(t => (
              <span key={t} className="chip">
                {t}
                <button className="chip-remove" onClick={() => removeTicker(t)}>×</button>
              </span>
            ))}
          </div>
          <div className="add-ticker-row" style={{ marginTop: 6 }}>
            <input
              className="ticker-input"
              placeholder="Add ticker…"
              value={addTickerInput}
              onChange={e => setAddTickerInput(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter') addTicker(addTickerInput) }}
            />
            <button className="btn-primary btn-sm" onClick={() => addTicker(addTickerInput)}>Add</button>
          </div>
          {/* Quick-add rows: Dashboard watchlist + signal/backtest history */}
          {watchlistTickers.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--dim)' }}>
              <span style={{ marginRight: 4, fontWeight: 500 }}>Dashboard:</span>
              {watchlistTickers.map(t => (
                <button key={t} className="btn-ghost btn-sm" style={{ marginRight: 4 }}
                        onClick={() => addTicker(t)} disabled={selTickers.includes(t)}
                        title={`Add ${t} from watchlist`}>{t}</button>
              ))}
              <button className="btn-ghost btn-sm"
                      style={{ marginLeft: 4, opacity: 0.6 }}
                      title="Add all watchlist tickers"
                      onClick={() => watchlistTickers.forEach(t => addTicker(t))}>
                + all
              </button>
            </div>
          )}
          {signalTickers.filter(t => !watchlistTickers.includes(t)).length > 0 && (
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dim)' }}>
              <span style={{ marginRight: 4, fontWeight: 500 }}>From past runs / signals:</span>
              {signalTickers.filter(t => !watchlistTickers.includes(t)).map(t => (
                <button key={t} className="btn-ghost btn-sm" style={{ marginRight: 4 }}
                        onClick={() => addTicker(t)} disabled={selTickers.includes(t)}
                        title={`Add ${t} (from signals or past backtest)`}>{t}</button>
              ))}
            </div>
          )}
        </div>

        {/* Time period */}
        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label className="settings-label">Time period</label>
          <div className="filter-group" style={{ marginBottom: 8 }}>
            {BT_PRESETS.map(p => (
              <button key={p.label}
                className={`filter-btn ${preset === p.label ? 'active' : ''}`}
                onClick={() => applyPreset(p)}>{p.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <label className="settings-label" style={{ fontSize: 11 }}>From</label>
              <input type="date" className="settings-select" value={startDate}
                     onChange={e => { setStartDate(e.target.value); setPreset('') }} />
            </div>
            <div>
              <label className="settings-label" style={{ fontSize: 11 }}>To</label>
              <input type="date" className="settings-select" value={endDate}
                     onChange={e => { setEndDate(e.target.value); setPreset('') }} />
            </div>
          </div>
          {startDate && new Date(startDate) < new Date(new Date().setFullYear(new Date().getFullYear() - 2)) && (
            <p style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 6 }}>
              ⚠ Window exceeds ~2 years — 1H/4H indicators unavailable; only daily-bar rules will fire.
            </p>
          )}
        </div>

        {/* Params — three labeled groups */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 12 }}>

          {/* ── Group 1: Signal Filtering ── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                          letterSpacing: '0.09em', marginBottom: 8 }}>
              Signal Filtering
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="settings-field" style={{ minWidth: 200 }}>
                <label className="settings-label"
                       title="Minimum AI confidence (0–100%) for a signal to be included in the backtest. Higher = fewer but stronger signals.">
                  Confidence floor: <strong>{confFloor}%</strong>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <input type="range" min={0} max={100} step={5} value={confFloor}
                         onChange={e => setConfFloor(Number(e.target.value))} className="filter-range"
                         style={{ flex: 1 }} />
                  <span className="filter-val">{confFloor}%</span>
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-label"
                       title="How often to scan for signals within each trading day. EOD = once per day at close (fastest). Finer intervals increase LLM call count proportionally.">
                  Scan interval
                </label>
                <div className="filter-group" style={{ marginTop: 4 }}>
                  {[
                    { label: 'EOD', val: 1440, tip: 'Once per day at market close' },
                    { label: '4h',  val: 240,  tip: '~2 scans/day' },
                    { label: '1h',  val: 60,   tip: '~7 scans/day' },
                    { label: '30m', val: 30,   tip: '~14 scans/day' },
                    { label: '15m', val: 15,   tip: '~27 scans/day' },
                  ].map(({ label, val, tip }) => (
                    <button key={val}
                            className={`filter-btn ${scanInterval === val ? 'active' : ''}`}
                            title={tip}
                            onClick={() => setScanInterval(val)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', marginBottom: 14, opacity: 0.4 }} />

          {/* ── Group 2: Trade Setup ── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                          letterSpacing: '0.09em', marginBottom: 8 }}>
              Trade Setup
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="settings-field">
                <label className="settings-label"
                       title="Stop distance = ATR × this multiple. Larger = wider stop, fewer premature exits but bigger losses when wrong.">
                  ATR multiple
                </label>
                <input type="number" min={0.1} step={0.1} value={atrMult}
                       onChange={e => setAtrMult(e.target.value)} className="settings-num-input"
                       style={{ marginTop: 4 }} />
              </div>
              <div className="settings-field">
                <label className="settings-label"
                       title="Target distance = stop distance × this ratio. E.g. 2.0 means you aim to win twice what you risk.">
                  Reward : Risk
                </label>
                <input type="number" min={0.1} step={0.1} value={rrRatio}
                       onChange={e => setRrRatio(e.target.value)} className="settings-num-input"
                       style={{ marginTop: 4 }} />
              </div>
              <div className="settings-field">
                <label className="settings-label"
                       title="If neither stop nor target is hit after this many days, the trade closes at the current price.">
                  Max hold days
                </label>
                <input type="number" min={1} max={120} value={maxHold}
                       onChange={e => setMaxHold(e.target.value)} className="settings-num-input"
                       style={{ marginTop: 4 }} />
              </div>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', marginBottom: 14, opacity: 0.4 }} />

          {/* ── Group 3: Virtual Wallet ── */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                          letterSpacing: '0.09em', marginBottom: 8 }}>
              Virtual Wallet
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="settings-field">
                <label className="settings-label"
                       title="Starting balance for the virtual wallet simulation">
                  Initial balance ($)
                </label>
                <input type="number" min={100} step={100} value={initBalance}
                       onChange={e => setInitBalance(e.target.value)} className="settings-num-input"
                       style={{ width: 100, marginTop: 4 }} />
              </div>
              <div className="settings-field" style={{ minWidth: 200 }}>
                <label className="settings-label"
                       title="Fraction of initial balance invested per signal (fixed-fractional sizing). E.g. 10% of $10,000 = $1,000 per trade.">
                  Position size: <strong>{posSizePct}%</strong>
                  <span style={{ marginLeft: 6, color: 'var(--dim)', fontSize: 11 }}>
                    = ${Math.round((parseFloat(initBalance) || 10000) * posSizePct / 100).toLocaleString()}/trade
                  </span>
                </label>
                <input type="range" min={1} max={25} step={1} value={posSizePct}
                       onChange={e => setPosSizePct(Number(e.target.value))}
                       className="filter-range" style={{ width: '100%', marginTop: 4 }} />
              </div>
              <div className="settings-field" style={{ minWidth: 210 }}>
                <label className="settings-label"
                       title="Cashout rule: exit a trade early when its unrealised R reaches this level, locking in profit before a reversal. Slide to 0 or press 'off' to disable.">
                  Cashout at R:{' '}
                  <strong style={{ color: cashoutR != null ? 'var(--yellow)' : undefined }}>
                    {cashoutR != null ? cashoutR + 'R' : 'off'}
                  </strong>
                  {cashoutR != null && rrRatio > 0 && (
                    <span style={{ marginLeft: 6, color: 'var(--dim)', fontSize: 11 }}>
                      (target is {Number(rrRatio).toFixed(1)}R)
                    </span>
                  )}
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <input type="range" min={0} max={20} step={1}
                         value={cashoutR != null ? Math.round(cashoutR * 4) : 0}
                         onChange={e => {
                           const v = Number(e.target.value)
                           setCashoutR(v === 0 ? null : +(v / 4).toFixed(2))
                         }}
                         className="filter-range" style={{ flex: 1 }} />
                  {cashoutR != null && (
                    <button onClick={() => setCashoutR(null)}
                            style={{ fontSize: 10, padding: '1px 6px', background: 'var(--surface-2)',
                                     border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                                     color: 'var(--dim)' }}>off</button>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* LLM toggle + RPM + OOS */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
          <div className="settings-field">
            <label className="settings-label">LLM mode</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className={`settings-toggle ${useLlm ? 'on' : 'off'}`} onClick={() => setUseLlm(v => !v)}>
                <span className="settings-toggle-knob" />
              </button>
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>{useLlm ? 'AI analysis on each day' : 'Rules only (faster)'}</span>
            </div>
          </div>
          {useLlm && (
            <div className="settings-field">
              <label className="settings-label">Requests/min cap</label>
              <input type="number" min={1} value={rpm} placeholder="no cap"
                     onChange={e => setRpm(e.target.value)} className="settings-num-input" />
            </div>
          )}
          <div className="settings-field">
            <label className="settings-label"
                   title="Mark this window as a held-out test set — AI Review will note it as out-of-sample evidence">
              Out-of-sample
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className={`settings-toggle ${isOos ? 'on' : 'off'}`} onClick={() => setIsOos(v => !v)}>
                <span className="settings-toggle-knob" />
              </button>
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>{isOos ? 'OOS holdout' : 'In-sample / training'}</span>
            </div>
          </div>
        </div>

        {/* ── Saved configurations ──────────────────────────────────────────── */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Existing profile chips */}
            {profiles.map(p => (
              <span key={p.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                color: 'var(--text)',
              }}
                title={`Created ${p.createdAt} · ${(p.params.tickers??[]).join(', ')} · Floor ${p.params.confFloor}% · ATR ${p.params.atrMult}× · R:R ${p.params.rrRatio}:1 · Hold ${p.params.maxHold}d`}
                onClick={() => _loadProfile(p)}>
                📋 {p.name}
                <button onClick={e => { e.stopPropagation(); _deleteProfile(p.id) }}
                        style={{ background:'none', border:'none', cursor:'pointer',
                                 color:'var(--dim)', fontSize:12, padding:'0 0 0 2px', lineHeight:1 }}
                        title="Delete this profile">×</button>
              </span>
            ))}

            {/* Save current params */}
            {showProfileSave ? (
              <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                <input autoFocus value={profileNameInput} onChange={e => setProfileNameInput(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter') _saveProfile(); if (e.key === 'Escape') setShowProfileSave(false) }}
                       placeholder="Profile name…"
                       style={{ fontSize:12, padding:'3px 8px', borderRadius:6,
                                background:'var(--surface-1)', border:'1px solid var(--accent)',
                                color:'var(--text)', outline:'none', width:140 }} />
                <button className="btn-primary btn-sm" onClick={_saveProfile}
                        disabled={!profileNameInput.trim()}>Save</button>
                <button className="btn-sm" onClick={() => setShowProfileSave(false)}
                        style={{ background:'var(--surface-2)', border:'1px solid var(--border)', color:'var(--dim)', borderRadius:6, padding:'3px 10px', cursor:'pointer', fontSize:12 }}>
                  Cancel
                </button>
              </span>
            ) : (
              <button onClick={() => setShowProfileSave(true)}
                      style={{ background:'none', border:'1px dashed var(--border)', color:'var(--dim)',
                               borderRadius:20, padding:'3px 12px', fontSize:12, cursor:'pointer' }}
                      title="Save current parameters as a named profile">
                + Save as profile
              </button>
            )}
          </div>
        </div>

        <button className="btn-primary" onClick={runBacktest}
                disabled={running || !selTickers.length}>
          {running ? 'Running…' : '▶ Run Backtest'}
        </button>
        {runError && <p style={{ color: 'var(--red)', marginTop: 8, fontSize: 13 }}>✗ {runError}</p>}
      </div>

      {/* ── Section 2: LLM pre-flight notifier (LLM mode only) ─────────────── */}
      {useLlm && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">2</span>
            <span className="section-label">LLM Quota Estimate</span>
            <span className="section-desc">Approximate cost before running</span>
          </div>
          <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Est. requests</span>
              <span className="usage-stat-value">{estRequests.toLocaleString()}</span>
              <span className="usage-stat-sub">
                {selTickers.length} ticker × ~{estDays} days × {scansPerDay} scan{scansPerDay !== 1 ? 's' : ''}/day
              </span>
            </div>
            <div className="usage-stat-card">
              <span className="usage-stat-label">Est. tokens</span>
              <span className="usage-stat-value">{avgTokens ? (estTokens/1000).toFixed(1)+'k' : '—'}</span>
              <span className="usage-stat-sub">{avgTokens ? `~${avgTokens} tok/call avg` : 'no usage history'}</span>
            </div>
            {rpmCap && (
              <div className="usage-stat-card">
                <span className="usage-stat-label">Est. duration</span>
                <span className="usage-stat-value">{estMinutes}m</span>
                <span className="usage-stat-sub">at {rpmCap} req/min</span>
              </div>
            )}
            {provLimits?.rpd && (
              <div className={`usage-stat-card ${overRpd ? 'usage-stat-card-warn' : ''}`}>
                <span className="usage-stat-label">Daily limit (RPD)</span>
                <span className="usage-stat-value" style={{ color: overRpd ? 'var(--red)' : undefined }}>
                  {provLimits.rpd.toLocaleString()}
                </span>
                <span className="usage-stat-sub">{overRpd ? '⚠ may exceed limit' : 'within limit'}</span>
              </div>
            )}
            {provLimits?.tpm && rpmCap && (
              <div className={`usage-stat-card ${overTpm ? 'usage-stat-card-warn' : ''}`}>
                <span className="usage-stat-label">TPM limit</span>
                <span className="usage-stat-value" style={{ color: overTpm ? 'var(--red)' : undefined }}>
                  {(provLimits.tpm/1000).toFixed(0)}k
                </span>
                <span className="usage-stat-sub">{overTpm ? '⚠ may throttle' : 'within limit'}</span>
              </div>
            )}
          </div>
          {(overRpd || overTpm) && (
            <p style={{ color: 'var(--yellow)', fontSize: 12, marginTop: 8 }}>
              ⚠ Estimated usage exceeds provider limits. Reduce tickers/window or lower RPM cap to stay within quota. Auto-fallback will engage if configured.
            </p>
          )}
        </div>
      )}

      {/* ── Section 3: Progress ────────────────────────────────────────────── */}
      {(running || progress > 0) && (
        <div className="explorer-section">
          <div className="section-header">
            <span className="section-badge">3</span>
            <span className="section-label">Progress</span>
          </div>
          <div className="stepper">
            <div className="stepper-bar-track">
              <div className="stepper-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 6 }}>
              {progressLabel || (running ? 'Starting…' : 'Complete')} — {progress}%
            </div>
          </div>
          {notices.map((n, i) => (
            <div key={i} style={{
              marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12,
              background: n.kind === 'quota' ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)',
              color: n.kind === 'quota' ? 'var(--red)' : 'var(--yellow)',
            }}>
              {n.kind === 'fallback' ? '🔄' : '⚠'} {n.msg}
            </div>
          ))}
          {/* Token usage shown in Section 4 Metrics once report loads */}
        </div>
      )}

      {/* ── Sections 4–8: Results (once a report is loaded) ────────────────── */}
      {report && (
        <>
          {/* ── Missing-metrics warning (orphaned run) ───────────────────── */}
          {!report.metrics && (
            <div style={{
              margin: '0 0 16px', padding: '10px 14px', borderRadius: 8,
              background: 'rgba(251,191,36,0.10)', border: '1px solid var(--yellow)',
              display: 'flex', gap: 10, alignItems: 'flex-start',
            }}>
              <span style={{ fontSize: 16 }}>⚠</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--yellow)', marginBottom: 3 }}>
                  No metrics for this run
                </div>
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>
                  This run was saved without metrics — it may have been interrupted or created by an older
                  version. Re-run the backtest with the same parameters to generate full results.
                </div>
              </div>
            </div>
          )}

          {/* ── Section 4: Metric tiles ──────────────────────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">4</span>
              <span className="section-label">Metrics</span>
              <span className="section-desc">
                {(() => {
                  const si = report.scan_interval_minutes ?? 1440
                  const siLbl = si >= 1440 ? 'EOD' : si >= 60 ? `${si / 60}h` : `${si}m`
                  const cashoutPart = report.metrics?.cashout_r != null ? ` · Cashout ${report.metrics.cashout_r}R` : ''
                  return `Scan ${siLbl} · Floor ${report.confidence_floor ?? '?'}% · ATR ${report.atr_multiple ?? '?'}× · R:R ${report.reward_risk ?? '?'}:1 · Hold ${report.max_hold_days ?? '?'}d${cashoutPart}`
                })()}
              </span>
            </div>
            <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Win rate</span>
                <span className="usage-stat-value">{fmtPct(liveMetrics?.win_rate)}</span>
                <span className="usage-stat-sub">{liveMetrics?.total_trades ?? 0} trades</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Avg R-multiple</span>
                <span className="usage-stat-value"
                      style={{ color: (liveMetrics?.avg_r_multiple ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {fmtR(liveMetrics?.avg_r_multiple)}
                </span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Sharpe ratio</span>
                <span className="usage-stat-value">{liveMetrics?.sharpe != null ? liveMetrics.sharpe.toFixed(2) : '—'}</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Max drawdown</span>
                <span className="usage-stat-value" style={{ color: 'var(--red)' }}>
                  {liveMetrics?.max_drawdown != null ? liveMetrics.max_drawdown.toFixed(2) + 'R' : '—'}
                </span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">False-positive rate</span>
                <span className="usage-stat-value">{fmtPct(liveMetrics?.false_positive_rate)}</span>
              </div>
              {(liveMetrics?.cashout_count ?? 0) > 0 && (
                <div className="usage-stat-card" title="Trades exited early by the cashout rule">
                  <span className="usage-stat-label">💰 Cashouts</span>
                  <span className="usage-stat-value" style={{ color: 'var(--yellow)' }}>
                    {liveMetrics.cashout_count}
                  </span>
                  <span className="usage-stat-sub">
                    of {liveMetrics.total_trades} trades · {report.metrics?.cashout_r}R rule
                  </span>
                </div>
              )}
            </div>
            {/* LLM usage row — always shown; shows 0 for rule-mode runs */}
            <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
              <div className="usage-stat-card">
                <span className="usage-stat-label">LLM calls</span>
                <span className="usage-stat-value">{(report?.llm_calls ?? 0).toLocaleString()}</span>
                <span className="usage-stat-sub">{(report?.llm_calls ?? 0) === 0 ? 'rule mode' : 'analyze() calls'}</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Run tokens</span>
                <span className="usage-stat-value">
                  {((report?.llm_prompt_tokens ?? 0) + (report?.llm_completion_tokens ?? 0)).toLocaleString()}
                </span>
                <span className="usage-stat-sub">prompt + completion</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Prompt tokens</span>
                <span className="usage-stat-value">{(report?.llm_prompt_tokens ?? 0).toLocaleString()}</span>
                <span className="usage-stat-sub">input</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Completion tokens</span>
                <span className="usage-stat-value">{(report?.llm_completion_tokens ?? 0).toLocaleString()}</span>
                <span className="usage-stat-sub">output</span>
              </div>
              <div className="usage-stat-card">
                <span className="usage-stat-label">Model</span>
                {/* value = provider name; sub = full model string */}
                <span className="usage-stat-value" style={{ fontSize: 13 }}
                      title={report?.llm_provider
                        ? `${report.llm_provider} · ${report.llm_model ?? 'model unknown'}`
                        : 'rule-based (no LLM)'}>
                  {report?.llm_provider ?? 'rule-based'}
                </span>
                <span className="usage-stat-sub" style={{ wordBreak: 'break-all' }}>
                  {report?.llm_model ?? (report?.llm_provider ? 'model unknown' : 'no LLM')}
                </span>
              </div>
            </div>
            {report?.warnings?.length > 0 && (
              <ul style={{ fontSize: 12, color: 'var(--yellow)', margin: '8px 0 0 0', paddingLeft: 18 }}>
                {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}

            {/* ── Virtual wallet summary tiles ── */}
            {report.metrics?.wallet && (() => {
              const w = report.metrics.wallet
              const bh = w.buy_and_hold
              const ret = w.total_return_pct ?? 0
              const bhRet = bh?.return_pct ?? null
              const alpha = (bhRet != null) ? round2(ret - bhRet) : null
              const fmtDollar = v => v != null
                ? `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                : '—'
              const fmtRetPct = v => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'
              function round2(v) { return Math.round(v * 100) / 100 }
              return (
                <div style={{ marginTop: 12 }}>
                  <div className="chart-title" style={{ marginBottom: 8 }}>
                    💰 Virtual wallet
                    <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 8, fontWeight: 400 }}>
                      {fmtDollar(w.initial_balance)} starting · {fmtDollar(w.position_size)}/trade ({Math.round((w.position_size_pct ?? 0.1) * 100)}%)
                    </span>
                  </div>
                  <div className="usage-summary-row" style={{ flexWrap: 'wrap', gap: 12 }}>
                    <div className="usage-stat-card">
                      <span className="usage-stat-label">Final portfolio</span>
                      <span className="usage-stat-value"
                            style={{ color: (w.total_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {fmtDollar(w.final_equity)}
                      </span>
                      <span className="usage-stat-sub"
                            style={{ color: (w.total_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {(w.total_pnl ?? 0) >= 0 ? '+' : ''}{fmtDollar(w.total_pnl)} P&L
                      </span>
                    </div>
                    <div className="usage-stat-card">
                      <span className="usage-stat-label">Strategy return</span>
                      <span className="usage-stat-value"
                            style={{ color: ret >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {fmtRetPct(ret)}
                      </span>
                      <span className="usage-stat-sub">on {fmtDollar(w.initial_balance)}</span>
                    </div>
                    {bhRet != null && (
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Buy &amp; hold</span>
                        <span className="usage-stat-value"
                              style={{ color: bhRet >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {fmtRetPct(bhRet)}
                        </span>
                        <span className="usage-stat-sub">equal-weight benchmark</span>
                      </div>
                    )}
                    {alpha != null && (
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Alpha vs B&amp;H</span>
                        <span className="usage-stat-value"
                              style={{ color: alpha >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {fmtRetPct(alpha)}
                        </span>
                        <span className="usage-stat-sub">{alpha >= 0 ? 'outperformed' : 'underperformed'}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* ── Section 5: Floor tuning ──────────────────────────────────── */}
          {report?.metrics?.floor_sweep?.length > 0 && (
            <div className="explorer-section">
              <div className="section-header">
                <span className="section-badge">5</span>
                <span className="section-label">Confidence-floor tuning</span>
                <span className="section-desc">Drag to re-filter results — no re-run needed</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <input type="range" min={0} max={100} step={5} value={liveFloor}
                       onChange={e => setLiveFloor(Number(e.target.value))} className="filter-range"
                       style={{ flex: 1 }} />
                <span className="filter-val" style={{ minWidth: 40 }}>{liveFloor}%</span>
              </div>
              <div className="chart-title" style={{ marginBottom: 6 }}>Win rate / Avg R / Trade count vs. floor</div>
              <ResponsiveContainer width="100%" height={130}>
                <AreaChart data={report.metrics.floor_sweep}
                           margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                  <XAxis dataKey="floor" tick={AXIS_TICK} axisLine={false} tickLine={false}
                         tickFormatter={v => v + '%'} />
                  <YAxis yAxisId="rate" domain={[0,1]} tick={AXIS_TICK} axisLine={false}
                         tickLine={false} width={30} tickFormatter={v => Math.round(v*100)+'%'} />
                  <YAxis yAxisId="count" orientation="right" tick={AXIS_TICK} axisLine={false}
                         tickLine={false} width={28} />
                  <Tooltip {...CHART_TOOLTIP_STYLE}
                    formatter={(v, name) => {
                      if (name === 'win_rate') return [fmtPct(v), 'Win rate']
                      if (name === 'avg_r_multiple') return [fmtR(v), 'Avg R']
                      return [v, 'Trades']
                    }}
                  />
                  <ReferenceLine yAxisId="rate" x={liveFloor} stroke="var(--accent)" strokeDasharray="4 2" />
                  <Area yAxisId="rate" type="monotone" dataKey="win_rate"
                        stroke="#3fb950" fill="rgba(63,185,80,0.15)" strokeWidth={1.5} dot={false} />
                  <Area yAxisId="rate" type="monotone" dataKey="avg_r_multiple"
                        stroke="#58a6ff" fill="rgba(88,166,255,0.1)" strokeWidth={1.5} dot={false} />
                  <Area yAxisId="count" type="monotone" dataKey="total_trades"
                        stroke="#8b949e" fill="none" strokeWidth={1} dot={false} strokeDasharray="3 2" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Section 6: Cumulative R-multiple curve ───────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">6</span>
              <span className="section-label">Cumulative R-multiple curve</span>
              <span className="section-desc">Running sum of risk-normalised P&L (floor: {liveFloor}%)</span>
            </div>
            {cumR.length > 1 ? (
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={cumR} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cumRGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#58a6ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                  <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false}
                         interval={Math.max(1, Math.floor(cumR.length / 6))} />
                  <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                         width={38} tickFormatter={v => v.toFixed(1) + 'R'} />
                  <Tooltip {...CHART_TOOLTIP_STYLE}
                    formatter={v => [fmtR(v), 'Cumulative R']} />
                  <ReferenceLine y={0} stroke="#8b949e" strokeDasharray="3 2" />
                  <Area type="monotone" dataKey="r" stroke="#58a6ff" strokeWidth={1.5}
                        fill="url(#cumRGrad)" dot={false} activeDot={{ r: 3, fill: '#58a6ff' }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="chart-empty">No trades at this confidence floor.</p>
            )}
          </div>

          {/* ── Section 6b: $ Portfolio equity curve ─────────────────────── */}
          {report.metrics?.wallet?.dollar_equity_curve?.length > 1 && (() => {
            const w = report.metrics.wallet
            // Merge strategy curve and BH curve on a unified date set
            const stratMap = Object.fromEntries(
              (w.dollar_equity_curve ?? []).map(p => [p.date, p.equity])
            )
            const bhMap = Object.fromEntries(
              (w.buy_and_hold?.daily_equity_curve ?? []).map(p => [p.date, p.equity])
            )
            const allDates = [...new Set([
              ...(w.dollar_equity_curve ?? []).map(p => p.date),
              ...(w.buy_and_hold?.daily_equity_curve ?? []).map(p => p.date),
            ])].filter(Boolean).sort()
            // Forward-fill
            let lastStr = w.initial_balance, lastBh = w.initial_balance
            const merged = allDates.map(date => {
              if (stratMap[date] != null) lastStr = stratMap[date]
              if (bhMap[date]   != null) lastBh  = bhMap[date]
              return { date, strategy: lastStr, buy_and_hold: bhMap[date] != null ? lastBh : undefined }
            })
            const hasBh = w.buy_and_hold?.daily_equity_curve?.length > 0
            const fmtUSD = v => `$${Math.round(v).toLocaleString()}`
            return (
              <div className="explorer-section">
                <div className="section-header">
                  <span className="section-badge">6b</span>
                  <span className="section-label">$ Portfolio equity curve</span>
                  <span className="section-desc">Virtual wallet value over the backtest window</span>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={merged} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="stratGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#58a6ff" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
                      </linearGradient>
                      {hasBh && (
                        <linearGradient id="bhGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#f0883e" stopOpacity={0.15} />
                          <stop offset="95%" stopColor="#f0883e" stopOpacity={0} />
                        </linearGradient>
                      )}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                    <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false}
                           interval={Math.max(1, Math.floor(merged.length / 6))} />
                    <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                           width={58} tickFormatter={fmtUSD} />
                    <Tooltip {...CHART_TOOLTIP_STYLE}
                      formatter={(v, name) => [
                        fmtUSD(v),
                        name === 'strategy' ? 'Strategy' : 'Buy & Hold',
                      ]} />
                    <ReferenceLine y={w.initial_balance} stroke="#8b949e" strokeDasharray="3 2"
                                   label={{ value: fmtUSD(w.initial_balance), position: 'insideTopRight',
                                            fontSize: 10, fill: '#8b949e' }} />
                    <Area type="monotone" dataKey="strategy" stroke="#58a6ff" strokeWidth={1.5}
                          fill="url(#stratGrad)" dot={false} activeDot={{ r: 3, fill: '#58a6ff' }} />
                    {hasBh && (
                      <Area type="monotone" dataKey="buy_and_hold" stroke="#f0883e" strokeWidth={1.5}
                            fill="url(#bhGrad)" dot={false} activeDot={{ r: 3, fill: '#f0883e' }}
                            strokeDasharray="4 2" />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
                {hasBh && (
                  <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, color: 'var(--dim)' }}>
                    <span><span style={{ color: '#58a6ff' }}>—</span> Strategy</span>
                    <span><span style={{ color: '#f0883e' }}>- -</span> Buy &amp; Hold</span>
                    <span style={{ marginLeft: 'auto' }}>
                      Reference line = ${(w.initial_balance ?? 0).toLocaleString()} starting balance
                    </span>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Section 7: Per-ticker breakdown ──────────────────────────── */}
          {report.metrics?.per_ticker?.length > 0 && (
            <div className="explorer-section">
              <div className="section-header">
                <span className="section-badge">7</span>
                <span className="section-label">Per-ticker breakdown</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th style={{ textAlign:'right' }}>Trades</th>
                      <th style={{ textAlign:'right' }}>Win rate</th>
                      <th style={{ textAlign:'right' }}>Avg R</th>
                      <th style={{ textAlign:'right' }}>Sharpe</th>
                      <th style={{ textAlign:'right' }}>Max DD</th>
                      {walletPosSz > 0 && <th style={{ textAlign:'right' }}>$ P&amp;L</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {report.metrics.per_ticker.map(r => {
                      const dpnl = walletPosSz > 0 ? (perTickerDollarPnl[r.ticker] ?? null) : null
                      return (
                      <tr key={r.ticker}>
                        <td><strong>{r.ticker}</strong></td>
                        <td style={{ textAlign:'right' }}>{r.total_trades}</td>
                        <td style={{ textAlign:'right', color: (r.win_rate??0)>=0.5?'var(--green)':'var(--red)' }}>{fmtPct(r.win_rate)}</td>
                        <td style={{ textAlign:'right', color: (r.avg_r_multiple??0)>=0?'var(--green)':'var(--red)' }}>{fmtR(r.avg_r_multiple)}</td>
                        <td style={{ textAlign:'right' }}>{r.sharpe != null ? r.sharpe.toFixed(2) : '—'}</td>
                        <td style={{ textAlign:'right', color:'var(--red)' }}>{r.max_drawdown != null ? r.max_drawdown.toFixed(2)+'R' : '—'}</td>
                        {walletPosSz > 0 && (
                          <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums',
                                       color: dpnl == null ? 'var(--dim)' : dpnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {dpnl == null ? '—' : `${dpnl >= 0 ? '+' : ''}$${Math.abs(dpnl).toFixed(0)}`}
                          </td>
                        )}
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Section 8: Trade list ─────────────────────────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">8</span>
              <span className="section-label">Trade list</span>
              <span className="section-desc">{filteredTrades.length} trades at ≥{liveFloor}% confidence</span>
            </div>
            {filteredTrades.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th><th>Date</th><th>Dir</th><th style={{ textAlign:'right' }}>Conf</th>
                      <th>Source</th><th style={{ textAlign:'right' }}>Entry</th>
                      <th style={{ textAlign:'right' }}>Stop</th><th style={{ textAlign:'right' }}>Target</th>
                      <th>Outcome</th><th style={{ textAlign:'right' }}>R</th>
                      {walletPosSz > 0 && <th style={{ textAlign:'right' }}>$ P&amp;L</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.slice(0, 200).map((t, i) => (
                      <tr key={i} style={{ opacity: (t.confidence??0) < liveFloor ? 0.4 : 1 }}>
                        <td><strong>{t.ticker}</strong></td>
                        <td style={{ fontVariantNumeric:'tabular-nums' }}>{t.signal_date}</td>
                        <td><span className={`badge ${t.type}`}>{t.type}</span></td>
                        <td style={{ textAlign:'right' }}>{t.confidence?.toFixed(0)}%</td>
                        <td style={{ fontSize:11, color:'var(--dim)' }}>{t.source}</td>
                        <td style={{ textAlign:'right' }}>{t.entry?.toFixed(2) ?? '—'}</td>
                        <td style={{ textAlign:'right', color:'var(--red)' }}>{t.stop?.toFixed(2) ?? '—'}</td>
                        <td style={{ textAlign:'right', color:'var(--green)' }}>{t.target?.toFixed(2) ?? '—'}</td>
                        <td style={{ color: t.outcome==='win'?'var(--green)':t.outcome==='loss'?'var(--red)':t.outcome==='cashout'?'var(--yellow)':'var(--dim)' }}
                            title={t.outcome==='cashout'?`Cashout exit at ${t.r_multiple}R — rule locked in profit before reversal`:undefined}>
                          {t.outcome==='cashout'?'💰 cashout':t.outcome ?? '—'}
                        </td>
                        <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums',
                                     color: (t.r_multiple??0)>=0?'var(--green)':'var(--red)' }}>
                          {t.r_multiple != null ? ((t.r_multiple>=0?'+':'')+t.r_multiple.toFixed(2)) : '—'}
                        </td>
                        {walletPosSz > 0 && (() => {
                          const dp = t.exit_date ? tradeDollarPnl(t) : null
                          return (
                            <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums',
                                         color: dp == null ? 'var(--dim)' : dp >= 0 ? 'var(--green)' : 'var(--red)' }}>
                              {dp == null ? '—' : `${dp >= 0 ? '+' : '-'}$${Math.abs(dp).toFixed(0)}`}
                            </td>
                          )
                        })()}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredTrades.length > 200 && (
                  <p style={{ fontSize:11, color:'var(--dim)', padding:'6px 10px' }}>
                    Showing first 200 of {filteredTrades.length} trades.
                  </p>
                )}
              </div>
            ) : (
              <p className="chart-empty">No trades at this confidence floor.</p>
            )}
          </div>

          {/* ── Section 9: AI Review (Feature 4) ─────────────────────────────── */}
          <div className="explorer-section">
            <div className="section-header">
              <span className="section-badge">9</span>
              <span className="section-label">AI Review</span>
              <span className="section-desc">Senior trader verdict on these results</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--dim)', marginBottom: 10 }}>
              An LLM acting as a senior, strict-judge trader evaluates the backtest metrics and gives an actionable verdict.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn-primary btn-sm" onClick={runAiReview}
                      disabled={aiReviewLoading || !reportRunId}>
                {aiReviewLoading ? '⏳ Analysing…' : '🧠 Get AI Review'}
              </button>
              <span className="provider-hint" title="💡 Gemini Flash or Mistral · reasoning none">ⓘ</span>
              <button className="btn-primary btn-sm" onClick={runFloorSuggest}
                      disabled={floorSuggestLoading || !reportRunId}
                      title="Ask the AI to assess this run and recommend parameter adjustments">
                {floorSuggestLoading ? '⏳ Thinking…' : '🧪 Experiment Advisor'}
              </button>
              <span className="provider-hint" title="💡 Groq Qwen3.6-27b or Gemini Flash · reasoning low">ⓘ</span>
              {report && (
                <button className="btn-secondary btn-sm"
                        title="Clone these params and flip the LLM mode"
                        onClick={() => cloneRunParams(report, true)}>
                  ↩ Re-run {report.signal_mode === 'llm' ? 'without LLM' : 'with LLM'}
                </button>
              )}
            </div>
            {aiReviewError && (
              <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>✗ {aiReviewError}</p>
            )}
            {floorSuggestError && (
              <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>✗ Experiment Advisor: {floorSuggestError}</p>
            )}
            {floorSuggest && (() => {
              const fs = floorSuggest
              const sc = fs.selected_candidate  // v2 selected candidate object
              const riskColor = { low: 'var(--green)', medium: 'var(--yellow)', high: 'var(--red)' }

              // Map backend change keys → {label, fmt, apply}
              const changeAppliers = {
                confidence_floor: { label: 'Confidence floor', fmt: v => `${v}%`,
                  apply: v => { setConfFloor(Number(v)); setLiveFloor(Number(v)) } },
                max_hold_days:    { label: 'Max hold days',   fmt: v => `${v}d`,  apply: v => setMaxHold(Number(v)) },
                atr_multiple:     { label: 'ATR multiple',    fmt: v => `${v}×`,  apply: v => setAtrMult(Number(v)) },
                reward_risk:      { label: 'Reward / risk',   fmt: v => `${v}:1`, apply: v => setRrRatio(Number(v)) },
              }
              // Current values for comparison
              const currentVals = {
                confidence_floor: report?.confidence_floor ?? confFloor,
                max_hold_days:    report?.max_hold_days    ?? maxHold,
                atr_multiple:     report?.atr_multiple     ?? atrMult,
                reward_risk:      report?.reward_risk      ?? rrRatio,
              }

              return (
                <div style={{
                  marginTop: 14, padding: '14px 16px',
                  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
                }}>
                  {/* header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>🧪 Experiment Advisor</span>
                    {sc?._auto_selected && (
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 600,
                        background: 'var(--yellow)22', color: 'var(--yellow)',
                      }} title="LLM found insufficient evidence for a confident pick; safest candidate shown">
                        ⚠ auto-selected
                      </span>
                    )}
                    {sc?.overfitting_risk && !sc?._auto_selected && (
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 600,
                        background: (riskColor[sc.overfitting_risk] || 'var(--dim)') + '22',
                        color: riskColor[sc.overfitting_risk] || 'var(--dim)',
                      }}>
                        Overfit risk: {sc.overfitting_risk}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>
                      {fs.model_used && `via ${fs.model_used}`}
                      {(fs.prompt_tokens || fs.completion_tokens) && (
                        ` · ${((fs.prompt_tokens ?? 0) + (fs.completion_tokens ?? 0)).toLocaleString()} tok`
                      )}
                    </span>
                  </div>

                  {/* Diagnosis — what failure mode is being addressed */}
                  {fs.diagnosis && (
                    <div style={{ fontSize: 12, color: 'var(--dim)', margin: '0 0 8px',
                      padding: '5px 10px', background: 'var(--surface)', borderRadius: 4 }}>
                      <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Diagnosis: </span>{fs.diagnosis}
                    </div>
                  )}

                  {/* LLM reasoning (why field) — show before hypothesis */}
                  {fs.reasoning && fs.reasoning !== fs.diagnosis && (
                    <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic', margin: '0 0 10px',
                      padding: '6px 10px', background: 'var(--surface)', borderRadius: 4 }}>
                      {fs.reasoning}
                    </p>
                  )}

                  {/* Hypothesis box */}
                  {sc?.hypothesis && (
                    <div style={{
                      padding: '8px 12px', background: 'var(--accent)11',
                      borderLeft: '3px solid var(--accent)', borderRadius: 4, marginBottom: 10,
                      fontSize: 13, fontWeight: 600,
                    }}>
                      {sc.hypothesis}
                    </div>
                  )}

                  {/* Changes: current → suggested */}
                  {sc?.changes && Object.keys(sc.changes).length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 5, marginBottom: 10 }}>
                      {Object.entries(sc.changes).map(([key, val]) => {
                        const meta = changeAppliers[key]
                        if (!meta) return null
                        const cur = currentVals[key]
                        const changed = String(val) !== String(cur)
                        return (
                          <div key={key} style={{
                            display: 'grid', gridTemplateColumns: '130px 1fr auto', gap: 8,
                            alignItems: 'center', padding: '5px 8px',
                            background: changed ? 'var(--accent)0d' : 'transparent', borderRadius: 5,
                          }}>
                            <span style={{ fontSize: 12, color: 'var(--dim)' }}>{meta.label}</span>
                            <span style={{ fontSize: 13 }}>
                              <span style={{ color: 'var(--dim)', textDecoration: 'line-through', marginRight: 6 }}>
                                {meta.fmt(cur)}
                              </span>
                              <span style={{ fontWeight: 700, color: 'var(--accent)' }}>→ {meta.fmt(val)}</span>
                            </span>
                            <button className="btn-secondary btn-sm" style={{ whiteSpace: 'nowrap' }}
                                    onClick={() => meta.apply(val)}>↑ Use</button>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Diagnostic support */}
                  {(sc?.diagnostic_support ?? []).length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--dim)', marginBottom: 3 }}>Evidence</div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--dim)' }}>
                        {sc.diagnostic_support.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    </div>
                  )}

                  {/* Success / failure criteria */}
                  {((sc?.success_criteria ?? []).length > 0 || (sc?.failure_criteria ?? []).length > 0) && (
                    <div style={{ display: 'flex', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
                      {(sc?.success_criteria ?? []).length > 0 && (
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)', marginBottom: 2 }}>✓ Success if</div>
                          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11 }}>
                            {sc.success_criteria.map((s, i) => <li key={i} style={{ color: 'var(--green)' }}>{s}</li>)}
                          </ul>
                        </div>
                      )}
                      {(sc?.failure_criteria ?? []).length > 0 && (
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', marginBottom: 2 }}>✗ Fail if</div>
                          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11 }}>
                            {sc.failure_criteria.map((f, i) => <li key={i} style={{ color: 'var(--red)' }}>{f}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Apply button */}
                  {sc?.changes && (
                    <button className="btn-primary btn-sm" onClick={() => {
                      Object.entries(sc.changes).forEach(([key, val]) => {
                        changeAppliers[key]?.apply(val)
                      })
                      document.querySelector('.bt-params-section')?.scrollIntoView({ behavior: 'smooth' })
                    }}>
                      ✦ Apply & scroll to params
                    </button>
                  )}

                  {/* Next step */}
                  {fs.next_step && (
                    <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8,
                      padding: '5px 10px', background: 'var(--surface)', borderRadius: 4,
                      borderLeft: '2px solid var(--accent)' }}>
                      <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Next: </span>{fs.next_step}
                    </div>
                  )}

                  {/* All candidates — always visible so user can pick manually */}
                  {(fs.candidates ?? []).length > 1 && (
                    <details style={{ marginTop: 12 }}>
                      <summary style={{ fontSize: 11, color: 'var(--dim)', cursor: 'pointer', userSelect: 'none' }}>
                        All {fs.candidates.length} candidates — pick manually
                      </summary>
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {fs.candidates.map(c => {
                          const isSel = c.candidate_id === sc?.candidate_id
                          return (
                            <div key={c.candidate_id} style={{
                              padding: '7px 10px', borderRadius: 6, fontSize: 12,
                              border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border)'}`,
                              background: isSel ? 'var(--accent)0d' : 'var(--surface)',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: 600 }}>{c.hypothesis}</span>
                                <button className="btn-secondary btn-sm" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                                        onClick={() => {
                                          Object.entries(c.changes ?? {}).forEach(([k, v]) => changeAppliers[k]?.apply(v))
                                          document.querySelector('.bt-params-section')?.scrollIntoView({ behavior: 'smooth' })
                                        }}>
                                  ↑ Apply
                                </button>
                              </div>
                              {c.diagnostic_support?.[0] && (
                                <div style={{ color: 'var(--dim)', marginTop: 3 }}>{c.diagnostic_support[0]}</div>
                              )}
                              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                                {Object.entries(c.changes ?? {}).map(([k, v]) => {
                                  const m = changeAppliers[k]
                                  return m ? (
                                    <span key={k} style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
                                      {m.label}: {m.fmt(currentVals[k])} → {m.fmt(v)}
                                    </span>
                                  ) : null
                                })}
                                <span style={{
                                  fontSize: 10, padding: '1px 6px', borderRadius: 99,
                                  background: (riskColor[c.overfitting_risk] || 'var(--dim)') + '22',
                                  color: riskColor[c.overfitting_risk] || 'var(--dim)',
                                }}>
                                  overfit: {c.overfitting_risk ?? '?'}
                                </span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </details>
                  )}
                </div>
              )
            })()}
            {aiReview && (() => {
              const ar = aiReview
              const stageColor = { reject: 'var(--red)', research_only: 'var(--yellow)',
                paper_trade: 'var(--accent)', limited_live_candidate: 'var(--green)' }
              const stageLabel = { reject: '🚫 Reject', research_only: '🔬 Research only',
                paper_trade: '📋 Paper trade', limited_live_candidate: '✅ Live candidate' }
              const edgeColor = ar.edge_assessment === 'positive' ? 'var(--green)'
                : ar.edge_assessment === 'negative' ? 'var(--red)' : 'var(--yellow)'
              const stage = ar.deployment_stage ?? (ar.recommendation === 'deploy' ? 'paper_trade'
                : ar.recommendation === 'discard' ? 'reject' : 'research_only')
              const STAGE_ORDER = ['reject', 'research_only', 'paper_trade', 'limited_live_candidate']
              const stageDesc = {
                reject:                 'Strategy has fatal flaws; do not proceed.',
                research_only:          'In-sample / tuning phase. Experiment to improve metrics.',
                paper_trade:            'Edge demonstrated on OOS data. Simulate with real prices.',
                limited_live_candidate: 'Robust OOS evidence. Ready for small live allocation.',
              }
              return (
                <div style={{ marginTop: 14 }}>
                  {/* ── Deployment stage progression strip ─────────────────── */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--dim)', marginBottom: 6 }}>
                      Deployment stage
                    </div>
                    <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden',
                      border: '1px solid var(--border)' }}>
                      {STAGE_ORDER.map((s, i) => {
                        const isSelected = s === stage
                        const color = stageColor[s] || 'var(--dim)'
                        const icons = { reject: '🚫', research_only: '🔬', paper_trade: '📋', limited_live_candidate: '✅' }
                        const labels = { reject: 'Reject', research_only: 'Research', paper_trade: 'Paper trade', limited_live_candidate: 'Live candidate' }
                        return (
                          <div key={s} title={stageDesc[s]} style={{
                            flex: 1, padding: '7px 4px', textAlign: 'center', cursor: 'default',
                            background: isSelected ? color + '22' : 'var(--surface)',
                            borderRight: i < STAGE_ORDER.length - 1 ? '1px solid var(--border)' : 'none',
                            borderTop: isSelected ? `2px solid ${color}` : '2px solid transparent',
                            transition: 'background 0.15s',
                          }}>
                            <div style={{ fontSize: 13 }}>{icons[s]}</div>
                            <div style={{ fontSize: 10, fontWeight: isSelected ? 700 : 400,
                              color: isSelected ? color : 'var(--dim)', marginTop: 2, lineHeight: 1.2 }}>
                              {labels[s]}
                            </div>
                            {isSelected && (
                              <div style={{ fontSize: 9, marginTop: 2, fontWeight: 700,
                                color, letterSpacing: '0.05em' }}>▲ NOW</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {/* Edge + evidence quality inline below the strip */}
                    <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {ar.edge_assessment && (
                        <span style={{
                          padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          background: edgeColor + '22', color: edgeColor,
                          border: `1px solid ${edgeColor}55`,
                        }}>Edge: {ar.edge_assessment}</span>
                      )}
                      {ar.evidence_quality && (
                        <span style={{ fontSize: 11, color: 'var(--dim)' }}>
                          Evidence: {ar.evidence_quality}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>
                        {ar.model_used && `via ${ar.model_used}`}
                        {(ar.prompt_tokens || ar.completion_tokens) && (
                          ` · ${((ar.prompt_tokens ?? 0) + (ar.completion_tokens ?? 0)).toLocaleString()} tok`
                        )}
                      </span>
                    </div>
                  </div>
                  {ar.verdict && (
                    <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}>{ar.verdict}</p>
                  )}
                  {/* Blocking issues — most critical */}
                  {(ar.blocking_issues ?? []).length > 0 && (
                    <div style={{ marginBottom: 8, padding: '8px 12px', background: 'rgba(248,113,113,0.08)',
                      borderLeft: '3px solid var(--red)', borderRadius: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)', marginBottom: 4 }}>
                        ⛔ Blocking issues
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                        {ar.blocking_issues.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
                      </ul>
                    </div>
                  )}
                  {(ar.strengths ?? []).length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)', marginBottom: 4 }}>✓ Strengths</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                        {ar.strengths.map((s, i) => <li key={i} style={{ marginBottom: 2 }}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  {(ar.weaknesses ?? []).length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>✗ Weaknesses</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                        {ar.weaknesses.map((w, i) => <li key={i} style={{ marginBottom: 2 }}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                  {ar.next_action && (
                    <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic', margin: 0 }}>
                      → {ar.next_action}
                    </p>
                  )}
                </div>
              )
            })()}
          </div>
        </>
      )}

      {/* ── Past runs + comparator ─────────────────────────────────────────── */}
      <div className="explorer-section">
        <div className="section-header">
          <span className="section-badge">📋</span>
          <span className="section-label">Past runs</span>
          <span className="section-desc">Click to load · select multiple for comparator</span>
        </div>
        {pastRuns.length === 0 && <p className="chart-empty">No runs yet.</p>}
        {pastRuns.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th><th>Tickers</th><th>Window</th><th>Mode</th><th>Model</th>
                  <th style={{ textAlign:'right' }} title="Confidence floor · ATR multiple · R:R · Max hold · Scan interval · Cashout">Params</th>
                  <th style={{ textAlign:'right' }}>Win rate</th>
                  <th style={{ textAlign:'right' }}>Avg R</th>
                  <th style={{ textAlign:'right' }}>Trades</th>
                  <th style={{ textAlign:'right' }} title="Wallet: final balance · P&L · cashout trade count">Wallet</th>
                  <th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {pastRuns.map(r => {
                  const m = r.metrics
                  const isOrphaned = !m || m.total_trades == null
                  const tokTotal = (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0)
                  const scanLbl = (() => {
                    const s = r.scan_interval_minutes ?? 1440
                    if (s >= 1440) return 'EOD'
                    if (s >= 60)   return `${s / 60}h`
                    return `${s}m`
                  })()
                  const paramsTitle = [
                    `Floor: ${r.confidence_floor ?? '?'}%`,
                    `ATR: ${r.atr_multiple ?? '?'}×`,
                    `R:R: ${r.reward_risk ?? '?'}:1`,
                    `Hold: ${r.max_hold_days ?? '?'}d`,
                    `Scan: ${scanLbl}`,
                    m?.cashout_r != null ? `Cashout: ${m.cashout_r}R` : null,
                    r.requests_per_minute ? `RPM cap: ${r.requests_per_minute}` : null,
                    r.is_out_of_sample ? 'OOS holdout' : 'In-sample',
                    (r.llm_calls ?? 0) > 0 ? `${fmtTokens(tokTotal)} tok · ${r.llm_calls} calls` : null,
                  ].filter(Boolean).join(' · ')
                  return (
                    <tr key={r.id}
                        style={{
                          cursor: 'pointer',
                          opacity: isOrphaned ? 0.6 : 1,
                          background: loadedRunId === r.id ? 'rgba(88,166,255,0.08)' : undefined,
                          outline: loadedRunId === r.id ? '1px solid rgba(88,166,255,0.35)' : undefined,
                        }}
                        title={isOrphaned ? 'No metrics — run was interrupted or created by an older version' : undefined}
                        onClick={() => loadRun(r.id)}>
                      <td onClick={e => { e.stopPropagation(); toggleCompare(r.id) }}>
                        <input type="checkbox" checked={compareSel.has(r.id)} readOnly
                               style={{ accentColor:'var(--accent)' }} />
                      </td>
                      <td>{(r.tickers ?? []).join(', ')}</td>
                      <td style={{ fontSize:11, color:'var(--dim)', fontVariantNumeric:'tabular-nums' }}>
                        {r.start_date?.slice(5)} → {r.end_date?.slice(5)}
                      </td>
                      <td>
                        <span className={`badge ${r.signal_mode === 'llm' ? 'long' : ''}`}
                              style={r.signal_mode !== 'llm' ? { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' } : {}}>
                          {r.signal_mode === 'llm' ? '🤖 LLM' : '📐 Rules'}
                        </span>
                      </td>
                      <td style={{ fontSize:10, color:'var(--dim)' }}
                          title={r.llm_provider
                            ? `${r.llm_provider} · ${r.llm_model ?? 'model unknown'}`
                            : 'rule-based (no LLM)'}>
                        <div style={{ fontWeight:500 }}>{r.llm_provider ?? '—'}</div>
                        {r.llm_model && (
                          <div style={{ fontSize:9, opacity:0.7, maxWidth:100, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {r.llm_model}
                          </div>
                        )}
                        {tokTotal > 0 && (
                          <div style={{ fontSize:9, opacity:0.55, marginTop:1 }}>
                            {fmtTokens(tokTotal)} tok
                          </div>
                        )}
                      </td>
                      {/* ── Params identity column ── */}
                      <td style={{ textAlign:'right', fontSize:10, color:'var(--dim)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}
                          title={paramsTitle}>
                        <div style={{ display:'flex', flexDirection:'column', gap:1, alignItems:'flex-end' }}>
                          <span title="Confidence floor">
                            🎯 {r.confidence_floor ?? '?'}%
                          </span>
                          <span title="ATR multiple · Reward:Risk">
                            📐 {r.atr_multiple ?? '?'}× · {r.reward_risk ?? '?'}:1
                          </span>
                          <span title="Max hold days">
                            ⏳ {r.max_hold_days ?? '?'}d
                          </span>
                          <span title={`Scan interval: ${r.scan_interval_minutes ?? 1440} min per replay day`}>
                            🔁 {scanLbl}
                          </span>
                          {m?.cashout_r != null && (
                            <span title={`Cashout rule: exit trades early at ${m.cashout_r}R`}
                                  style={{ color: 'var(--yellow)' }}>
                              💰 {m.cashout_r}R
                            </span>
                          )}
                          {r.is_out_of_sample ? (
                            <span style={{ color:'var(--accent)', fontWeight:600 }} title="Out-of-sample holdout">OOS</span>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ textAlign:'right' }}>{fmtPct(m?.win_rate)}</td>
                      <td style={{ textAlign:'right', color: (m?.avg_r_multiple??0)>=0?'var(--green)':'var(--red)' }}>{fmtR(m?.avg_r_multiple)}</td>
                      <td style={{ textAlign:'right' }}>{m?.total_trades ?? '—'}</td>
                      {(() => {
                        const w = m?.wallet
                        if (!w) return <td style={{ textAlign:'right', color:'var(--dim)' }}>—</td>
                        const pnl = w.total_pnl ?? 0
                        const ret = w.total_return_pct ?? 0
                        const finalEq = w.final_equity ?? 0
                        const cashouts = m?.cashout_count ?? 0
                        return (
                          <td style={{ textAlign:'right', fontVariantNumeric:'tabular-nums', fontSize: 11 }}
                              title={`Started $${(w.initial_balance??0).toLocaleString()} · Final $${finalEq.toLocaleString()}`}>
                            {/* Final balance — the "money in wallet" */}
                            <div style={{ fontWeight: 600, fontSize: 12,
                                          color: finalEq >= (w.initial_balance ?? 0) ? 'var(--green)' : 'var(--red)' }}>
                              ${Math.round(finalEq).toLocaleString()}
                            </div>
                            {/* P&L delta */}
                            <div style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)', opacity: 0.85 }}>
                              {pnl >= 0 ? '+' : '-'}${Math.abs(Math.round(pnl)).toLocaleString()} ({ret >= 0 ? '+' : ''}{ret.toFixed(1)}%)
                            </div>
                            {/* Cashout trade count */}
                            {cashouts > 0 && (
                              <div style={{ color: 'var(--yellow)', opacity: 0.9 }}>
                                💰 {cashouts} cashout{cashouts > 1 ? 's' : ''}
                              </div>
                            )}
                          </td>
                        )
                      })()}
                      <td style={{ fontSize:11, color: r.status==='done'?'var(--green)':r.status==='error'?'var(--red)':'var(--dim)' }}>{r.status}</td>
                      <td onClick={e => { e.stopPropagation(); deleteRun(r.id) }}>
                        <button className="btn-delete" title="Delete run">×</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Comparator — shown when 2+ runs are selected */}
        {compareRuns.length >= 2 && (
          <div style={{ marginTop: 20 }}>
            <div className="chart-title" style={{ marginBottom: 10 }}>
              Runs comparator — {compareRuns.length} runs selected
            </div>
            {/* Side-by-side metrics */}
            {(() => {
              // Helper: for numeric rows, highlight the best value
              const bestIdx = (vals, higherIsBetter) => {
                if (vals.length < 2) return -1
                const nums = vals.map(v => (v == null || v === '—' || isNaN(Number(v)) ? null : Number(v)))
                if (nums.every(v => v == null)) return -1
                const valid = nums.filter(v => v != null)
                const best = higherIsBetter ? Math.max(...valid) : Math.min(...valid)
                const idx = nums.findIndex(v => v === best)
                return nums.filter(v => v === best).length === 1 ? idx : -1  // no highlight if tied
              }
              const hasWallet = compareRuns.some(r => r.metrics?.wallet)
              const rows = [
                // label, valueFn, rawNumFn (for best-highlighting), higherIsBetter
                ['Period',        r => `${r.start_date?.slice(5)} → ${r.end_date?.slice(5)}`, null, null],
                ['Mode',          r => r.signal_mode === 'llm' ? '🤖 LLM' : '📐 Rules', null, null],
                ['Floor',         r => (r.confidence_floor ?? '—') + '%', null, null],
                ['ATR ×  R:R',    r => `${r.atr_multiple ?? '?'}× · ${r.reward_risk ?? '?'}:1`, null, null],
                ['Max hold',      r => r.max_hold_days != null ? r.max_hold_days + 'd' : '—', null, null],
                ['—', null, null, null],  // divider
                ['Total trades',  r => fmtNum(r.metrics?.total_trades), r => r.metrics?.total_trades, true],
                ['Win rate',      r => fmtPct(r.metrics?.win_rate), r => r.metrics?.win_rate, true],
                ['Avg R',         r => fmtR(r.metrics?.avg_r_multiple), r => r.metrics?.avg_r_multiple, true],
                ['After-cost Avg R', r => r.metrics?.after_cost_avg_r != null ? fmtR(r.metrics.after_cost_avg_r) : '—', r => r.metrics?.after_cost_avg_r, true],
                ['Sharpe',        r => r.metrics?.sharpe != null ? r.metrics.sharpe.toFixed(2) : '—', r => r.metrics?.sharpe, true],
                ['Max drawdown',  r => r.metrics?.max_drawdown != null ? r.metrics.max_drawdown.toFixed(2)+'R' : '—', r => r.metrics?.max_drawdown, false],
                ['Fee stress',    r => r.metrics?.fee_stress_pass != null ? (r.metrics.fee_stress_pass ? '✓ pass' : '✗ fail') : '—', null, null],
                ...(hasWallet ? [
                  ['—', null, null, null],  // divider
                  ['Initial balance', r => r.metrics?.wallet ? `$${(r.metrics.wallet.initial_balance ?? 0).toLocaleString()}` : '—', null, null],
                  ['Position size',   r => r.metrics?.wallet ? `$${(r.metrics.wallet.position_size ?? 0).toLocaleString()} (${((r.metrics.wallet.position_size_pct ?? 0)*100).toFixed(0)}%)` : '—', null, null],
                  ['Final equity',    r => r.metrics?.wallet ? `$${(r.metrics.wallet.final_equity ?? 0).toLocaleString()}` : '—', r => r.metrics?.wallet?.final_equity, true],
                  ['Strategy return', r => r.metrics?.wallet?.total_return_pct != null ? `${r.metrics.wallet.total_return_pct >= 0 ? '+' : ''}${r.metrics.wallet.total_return_pct.toFixed(1)}%` : '—', r => r.metrics?.wallet?.total_return_pct, true],
                  ['Strategy $ P&L',  r => r.metrics?.wallet?.total_pnl != null ? `${r.metrics.wallet.total_pnl >= 0 ? '+' : '-'}$${Math.abs(r.metrics.wallet.total_pnl).toFixed(0)}` : '—', r => r.metrics?.wallet?.total_pnl, true],
                  ['Buy & Hold',      r => r.metrics?.wallet?.buy_and_hold?.return_pct != null ? `${r.metrics.wallet.buy_and_hold.return_pct >= 0 ? '+' : ''}${r.metrics.wallet.buy_and_hold.return_pct.toFixed(1)}%` : '—', r => r.metrics?.wallet?.buy_and_hold?.return_pct, true],
                  ['Alpha vs B&H',    r => {
                    const sp = r.metrics?.wallet?.total_return_pct; const bh = r.metrics?.wallet?.buy_and_hold?.return_pct
                    if (sp == null || bh == null) return '—'
                    const a = sp - bh; return `${a >= 0 ? '+' : ''}${a.toFixed(1)} pp`
                  }, r => { const sp = r.metrics?.wallet?.total_return_pct; const bh = r.metrics?.wallet?.buy_and_hold?.return_pct; return sp != null && bh != null ? sp - bh : null }, true],
                ] : []),
              ]
              return (
              <div className="table-wrap" style={{ marginBottom: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 120 }}>Metric</th>
                      {compareRuns.map((r,i) => (
                        <th key={r.id} style={{ color: BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length], textAlign:'right' }}>
                          Run #{r.id}
                          <div style={{ fontWeight:400, fontSize:10, opacity:0.7 }}>
                            {(r.tickers??[]).join(',')} · {r.signal_mode === 'llm' ? 'LLM' : 'Rules'}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([label, fn, numFn, higherIsBetter], ri) => {
                      if (label === '—') return (
                        <tr key={ri}><td colSpan={compareRuns.length + 1} style={{ padding: '2px 0', borderTop: '1px solid var(--border)' }}></td></tr>
                      )
                      const vals = compareRuns.map(r => fn(r))
                      const rawNums = numFn ? compareRuns.map(r => numFn(r)) : null
                      const best = rawNums ? bestIdx(rawNums, higherIsBetter) : -1
                      return (
                        <tr key={label}>
                          <td style={{ color:'var(--dim)', fontSize:12 }}>{label}</td>
                          {compareRuns.map((r, ci) => (
                            <td key={r.id} style={{
                              textAlign:'right',
                              fontWeight: best === ci ? 700 : 400,
                              color: best === ci ? 'var(--green)' : undefined,
                            }}>{vals[ci]}</td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              )
            })()}

            {/* Overlaid cumulative-R curves */}
            <div className="chart-title" style={{ marginBottom: 6 }}>Cumulative R — overlaid</div>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={compareChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                <XAxis dataKey="i" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                       width={38} tickFormatter={v => v.toFixed(1)+'R'} />
                <Tooltip {...CHART_TOOLTIP_STYLE}
                  formatter={(v, name) => [fmtR(v), name.replace('run_', 'Run #')]} />
                <ReferenceLine y={0} stroke="#8b949e" strokeDasharray="3 2" />
                {compareRuns.map((r, i) => (
                  <Area key={r.id} type="monotone" dataKey={`run_${r.id}`}
                    stroke={BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}
                    fill={`${BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}22`}
                    strokeWidth={1.5} dot={false} connectNulls />
                ))}
              </AreaChart>
            </ResponsiveContainer>

            {/* Overlaid $ equity curves — only when wallet data is present */}
            {compareDollarChartData.length > 0 && compareRuns.some(r => r.metrics?.wallet?.dollar_equity_curve?.length) && (
              <>
                <div className="chart-title" style={{ marginBottom: 6, marginTop: 14 }}>$ Portfolio equity — overlaid</div>
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={compareDollarChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#30363d" strokeOpacity={0.5} />
                    <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                    <YAxis domain={['auto','auto']} tick={AXIS_TICK} axisLine={false} tickLine={false}
                           width={56} tickFormatter={v => '$'+Math.round(v).toLocaleString()} />
                    <Tooltip {...CHART_TOOLTIP_STYLE}
                      formatter={(v, name) => [`$${Number(v).toLocaleString()}`, name.replace('run_', 'Run #')]} />
                    {compareRuns.filter(r => r.metrics?.wallet).map((r, i) => {
                      const init = r.metrics.wallet.initial_balance ?? 0
                      return <ReferenceLine key={`ref_${r.id}`} y={init} stroke={BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]} strokeDasharray="3 2" strokeOpacity={0.4} />
                    })}
                    {compareRuns.map((r, i) => (
                      r.metrics?.wallet?.dollar_equity_curve?.length ? (
                        <Area key={r.id} type="monotone" dataKey={`run_${r.id}`}
                          stroke={BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}
                          fill={`${BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length]}22`}
                          strokeWidth={1.5} dot={false} connectNulls />
                      ) : null
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </>
            )}

            {/* AI Compare */}
            {(() => {
              const hasLlmVsRules =
                compareRuns.some(r => r.signal_mode === 'llm') &&
                compareRuns.some(r => r.signal_mode === 'rules')
              return (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <button className="btn-primary btn-sm" onClick={runAiCompare}
                            disabled={aiCompareLoading}>
                      {aiCompareLoading ? '⏳ Comparing…' : '🧠 AI Compare'}
                    </button>
                    <span className="provider-hint" title="💡 Groq Qwen3.6-27b · reasoning default">ⓘ</span>
                    {hasLlmVsRules && (
                      <span className="badge" style={{
                        background: 'rgba(251,191,36,0.18)', color: 'var(--yellow)',
                        border: '1px solid rgba(251,191,36,0.35)', fontSize: 11,
                      }}>⚡ LLM vs Rules</span>
                    )}
                  </div>
                  {aiCompareError && (
                    <p style={{ color: 'var(--red)', fontSize: 13 }}>✗ {aiCompareError}</p>
                  )}
                  {aiCompare && (
                    <div style={{
                      padding: '12px 16px', background: 'var(--surface-2)',
                      border: '1px solid var(--border)', borderRadius: 8,
                    }}>
                      {/* Header row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                        {/* Comparability badge */}
                        {aiCompare.comparability && (
                          <span style={{
                            padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                            background: aiCompare.comparability === 'full' ? 'rgba(52,211,153,0.15)'
                              : aiCompare.comparability === 'partial' ? 'rgba(251,191,36,0.15)'
                              : 'rgba(248,113,113,0.15)',
                            color: aiCompare.comparability === 'full' ? 'var(--green)'
                              : aiCompare.comparability === 'partial' ? 'var(--yellow)' : 'var(--red)',
                          }}>
                            {aiCompare.comparability === 'full' ? '✓ Fully comparable'
                              : aiCompare.comparability === 'partial' ? '⚠ Partially comparable'
                              : '✗ Not comparable'}
                          </span>
                        )}
                        {/* Winner badge */}
                        {aiCompare.winner_run_id != null && (
                          <span style={{
                            padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                            background: 'rgba(52,211,153,0.18)', color: 'var(--green)',
                            border: '1px solid rgba(52,211,153,0.3)',
                          }}>
                            🏆 Run #{aiCompare.winner_run_id} wins
                            {aiCompare.winner_confidence && aiCompare.winner_confidence !== 'none' && (
                              <span style={{ fontWeight: 400, marginLeft: 5, fontSize: 11 }}>
                                ({aiCompare.winner_confidence} confidence)
                              </span>
                            )}
                          </span>
                        )}
                        <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>
                          {aiCompare.model_used && `via ${aiCompare.model_used}`}
                          {(aiCompare.prompt_tokens || aiCompare.completion_tokens) && (
                            ` · ${((aiCompare.prompt_tokens ?? 0) + (aiCompare.completion_tokens ?? 0)).toLocaleString()} tok`
                          )}
                        </span>
                      </div>
                      {/* LLM value-add */}
                      {aiCompare.llm_value_add?.assessment && aiCompare.llm_value_add.assessment !== 'not_applicable' && (
                        <div style={{
                          fontSize: 12, marginBottom: 10, padding: '6px 10px',
                          background: 'var(--surface-1)', borderRadius: 6,
                        }}>
                          <span style={{ fontWeight: 600, marginRight: 6 }}>LLM vs Rules:</span>
                          <span style={{
                            fontWeight: 700,
                            color: aiCompare.llm_value_add.assessment === 'adds' ? 'var(--green)'
                              : aiCompare.llm_value_add.assessment === 'detracts' ? 'var(--red)'
                              : 'var(--dim)',
                          }}>{aiCompare.llm_value_add.assessment}</span>
                          {aiCompare.llm_value_add.reason && (
                            <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
                              — {aiCompare.llm_value_add.reason}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Summary */}
                      {aiCompare.summary && (
                        <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>{aiCompare.summary}</p>
                      )}
                      {/* Per-run */}
                      {(aiCompare.per_run ?? []).map((pr, i) => (
                        <div key={pr.run_id} style={{ marginBottom: 10 }}>
                          <div style={{
                            fontSize: 12, fontWeight: 600, marginBottom: 4,
                            color: BT_COMPARATOR_COLORS[i % BT_COMPARATOR_COLORS.length],
                          }}>
                            Run #{pr.run_id}
                            {pr.evidence_quality && (
                              <span style={{ fontWeight: 400, color: 'var(--dim)', marginLeft: 6 }}>
                                · {pr.evidence_quality} evidence
                              </span>
                            )}
                          </div>
                          {(pr.strengths ?? []).length > 0 && (
                            <ul style={{ margin: '0 0 4px', paddingLeft: 18, fontSize: 12 }}>
                              {pr.strengths.map((s, j) => (
                                <li key={j} style={{ color: 'var(--green)', marginBottom: 1 }}>{s}</li>
                              ))}
                            </ul>
                          )}
                          {(pr.weaknesses ?? []).length > 0 && (
                            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                              {pr.weaknesses.map((w, j) => (
                                <li key={j} style={{ color: 'var(--red)', marginBottom: 1 }}>{w}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                      {/* Recommendation */}
                      {aiCompare.recommendation && (
                        <p style={{ fontSize: 13, fontWeight: 600, margin: '8px 0 0' }}>
                          → {aiCompare.recommendation}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>

    </div>
  )
}
