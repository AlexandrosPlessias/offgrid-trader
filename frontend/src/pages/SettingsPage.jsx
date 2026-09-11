import { useState, useEffect } from 'react'
import { API, getAuthHeaders } from '../utils/api'
import UsageSection from './UsageSection'
import InfoTip from '../components/shared/InfoTip'

const SETTINGS_SECTIONS = [
  { id: 'settings-signal',       icon: '📡', label: 'Signal Config' },
  { id: 'settings-paper',        icon: '📈', label: 'Paper Trading' },
  { id: 'settings-ai-provider', icon: '🧠', label: 'AI Provider' },
  { id: 'settings-usage',       icon: '⚡', label: 'AI Usage' },
  { id: 'settings-perf',        icon: '🚀', label: 'Performance' },
  { id: 'settings-discovery',   icon: '🔥', label: 'Discovery' },
  { id: 'settings-cache',       icon: '💾', label: 'Data Cache' },
  { id: 'settings-data',        icon: '🗑️', label: 'Data' },
]

function SettingSection({ id, title, icon, children }) {
  return (
    <div id={id} className="settings-section">
      <div className="settings-section-title">{icon} {title}</div>
      {children}
    </div>
  )
}

function DiscoverySettingsSection() {
  const [cfg,         setCfg]         = useState(null)
  const [fetchErr,    setFetchErr]    = useState(false)
  const [saveStatus,  setSaveStatus]  = useState(null)
  const [saveErr,     setSaveErr]     = useState('')

  // local editable copies
  const [enabled,          setEnabled]          = useState(false)
  const [sources,          setSources]          = useState('alpaca,yfinance')
  const [maxCandidates,    setMaxCandidates]    = useState(25)
  const [minScore,         setMinScore]         = useState(60)
  const [intervalMinutes,  setIntervalMinutes]  = useState(60)
  const [autoscanEnabled,  setAutoscanEnabled]  = useState(false)
  const [autoscanTopN,     setAutoscanTopN]     = useState(3)

  useEffect(() => {
    fetch(`${API}/settings/discovery`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => {
        setCfg(d)
        setEnabled(d.enabled ?? false)
        setSources(d.sources ?? 'alpaca,yfinance')
        setMaxCandidates(d.max_candidates ?? 25)
        setMinScore(d.min_score ?? 60)
        setIntervalMinutes(d.interval_minutes ?? 60)
        setAutoscanEnabled(d.autoscan_enabled ?? false)
        setAutoscanTopN(d.autoscan_top_n ?? 3)
      })
      .catch(() => setFetchErr(true))
  }, [])

  const save = async () => {
    setSaveStatus('saving'); setSaveErr('')
    try {
      const r = await fetch(`${API}/settings/discovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          enabled,
          sources,
          max_candidates: maxCandidates,
          min_score: minScore,
          interval_minutes: intervalMinutes,
          autoscan_enabled: autoscanEnabled,
          autoscan_top_n: autoscanTopN,
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setCfg(d)
      setSaveStatus('ok')
      setTimeout(() => setSaveStatus(null), 3000)
    } catch (e) {
      setSaveErr(e.message || 'Save failed')
      setSaveStatus('error')
      setTimeout(() => setSaveStatus(null), 4000)
    }
  }

  return (
    <SettingSection id="settings-discovery" title="Trending Discovery" icon="🔥">
      {fetchErr && (
        <p className="text-dim" style={{ fontSize: 13, color: 'var(--red)', marginBottom: 12 }}>
          ⚠ Could not load discovery settings — backend may still be starting up. Reload to retry.
        </p>
      )}
      {!cfg && !fetchErr && (
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 12 }}>Loading…</p>
      )}
      {cfg && (<>
      <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
        Automatically discover trending tickers from Alpaca screener and/or yfinance.
        Candidates are scored 0–100 using momentum, volume, trend alignment, and RSI/MACD.
      </p>

      <div className="settings-row">
        <label className="settings-label">Enable discovery</label>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
      </div>

      <div className="settings-row">
        <label className="settings-label">Sources</label>
        <input
          className="settings-input"
          value={sources}
          onChange={e => setSources(e.target.value)}
          placeholder="alpaca,yfinance"
          style={{ width: 220 }}
        />
        <span className="text-dim" style={{ fontSize: 11, marginLeft: 8 }}>comma-separated</span>
      </div>

      <div className="settings-row">
        <label className="settings-label">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Max candidates
            <InfoTip text="How many trending tickers the discovery scan evaluates each run." />
          </span>
        </label>
        <input
          className="settings-input"
          type="number" min={5} max={100}
          value={maxCandidates}
          onChange={e => setMaxCandidates(Number(e.target.value))}
          style={{ width: 80 }}
        />
        <span className="text-dim" style={{ fontSize: 11, marginLeft: 8 }}>per run (5–100)</span>
      </div>

      <div className="settings-row">
        <label className="settings-label">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Min score
            <InfoTip text="Minimum trending score (0–100) a ticker must reach before it appears in the Discovery tab." />
          </span>
        </label>
        <input
          className="settings-input"
          type="number" min={0} max={100}
          value={minScore}
          onChange={e => setMinScore(Number(e.target.value))}
          style={{ width: 80 }}
        />
        <span className="text-dim" style={{ fontSize: 11, marginLeft: 8 }}>0–100</span>
      </div>

      <div className="settings-row">
        <label className="settings-label">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Interval
            <InfoTip text="How often the trending ticker discovery scan runs to find new opportunities outside your watchlist." />
          </span>
        </label>
        <input
          className="settings-input"
          type="number" min={15} max={1440}
          value={intervalMinutes}
          onChange={e => setIntervalMinutes(Number(e.target.value))}
          style={{ width: 80 }}
        />
        <span className="text-dim" style={{ fontSize: 11, marginLeft: 8 }}>minutes between runs (15–1440)</span>
      </div>

      <div className="settings-row">
        <label className="settings-label">Auto-scan top-N</label>
        <input type="checkbox" checked={autoscanEnabled} onChange={e => setAutoscanEnabled(e.target.checked)} />
        {autoscanEnabled && (
          <input
            className="settings-input"
            type="number" min={1} max={20}
            value={autoscanTopN}
            onChange={e => setAutoscanTopN(Number(e.target.value))}
            style={{ width: 60, marginLeft: 10 }}
          />
        )}
        <span className="text-dim" style={{ fontSize: 11, marginLeft: 8 }}>
          {autoscanEnabled ? `Run full agent pipeline on top ${autoscanTopN} candidates` : 'Disabled'}
        </span>
      </div>

      <SaveRow status={saveStatus} errMsg={saveErr} onSave={save} />
      </>)}
    </SettingSection>
  )
}

function SaveRow({ status, errMsg, onSave, label = 'Save' }) {
  return (
    <div className="settings-save-row">
      <button className="btn-primary btn-sm" onClick={onSave} disabled={status === 'saving'}>
        {status === 'saving' ? 'Saving…' : label}
      </button>
      {status === 'ok'    && <span className="settings-ok">✓ Saved</span>}
      {status === 'error' && <span className="settings-err">✗ {errMsg || 'Failed'}</span>}
    </div>
  )
}

export default function SettingsPage({ usage, onUsageRefresh, onHealthRefresh, initialSection = null, onInitialSectionConsumed }) {
  // Scroll to a specific section when opened from another page (e.g. Trending → Discovery)
  useEffect(() => {
    if (!initialSection) return
    const el = document.getElementById(initialSection)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    onInitialSectionConsumed?.()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── LLM Provider ────────────────────────────────────────────────────────────
  const [llmProvider,  setLlmProvider]  = useState('ollama')
  const [llmApiKey,    setLlmApiKey]    = useState('')
  const [llmModel,     setLlmModel]     = useState('')
  const [llmBaseUrl,   setLlmBaseUrl]   = useState('')
  const [llmApiKeySet, setLlmApiKeySet] = useState(false)
  const [showLlmApiKey, setShowLlmApiKey] = useState(false)
  const [llmStatus,    setLlmStatus]    = useState(null)
  const [llmErr,       setLlmErr]       = useState('')
  const [useEnvDefaults, setUseEnvDefaults] = useState(false)
  const [llmModelEnvDefault,   setLlmModelEnvDefault]   = useState('')
  const [llmBaseUrlEnvDefault, setLlmBaseUrlEnvDefault] = useState('')
  const [llmApiKeyEnvSet,      setLlmApiKeyEnvSet]      = useState(false)
  const [llmReasoningEffort,   setLlmReasoningEffort]   = useState('none')
  const [providerModels,       setProviderModels]       = useState([])
  const [modelChoice,          setModelChoice]          = useState('')
  const [llmFallbackProvider,  setLlmFallbackProvider]  = useState('')
  const [llmFallbackModel,     setLlmFallbackModel]     = useState('')

  // ── Signal-scan LLM switch ──────────────────────────────────────────────────
  const [signalLlmEnabled,     setSignalLlmEnabled]     = useState(true)
  const [signalLlmSaveStatus,  setSignalLlmSaveStatus]  = useState(null)   // null|'saving'|'ok'|'error'

  const saveSignalLlmEnabled = async (enabled) => {
    setSignalLlmSaveStatus('saving')
    try {
      const r = await fetch(`${API}/settings/signal-scan-llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ enabled }),
      })
      if (!r.ok) throw new Error(await r.text())
      setSignalLlmEnabled(enabled)
      setSignalLlmSaveStatus('ok')
      setTimeout(() => setSignalLlmSaveStatus(null), 3000)
    } catch (e) {
      setSignalLlmSaveStatus('error')
      setTimeout(() => setSignalLlmSaveStatus(null), 4000)
    }
  }

  const cloudModelSuggestions = {
    groq: ['qwen/qwen3.6-27b'],
    gemini: ['gemini-3.5-flash-lite', 'gemini-3.5-flash'],
    mistral: ['mistral-small-latest', 'mistral-large-latest'],
  }
  const REASONING_OPTIONS = ['none', 'low', 'medium', 'high']
  const supportsReasoning = ['groq', 'gemini', 'mistral'].includes(llmProvider)
  const ollamaModelSuggestions = ['qwen2.5:3b', 'qwen2.5:7b', 'qwen2.5:14b']
  const envDefaultsActive = useEnvDefaults && llmProvider !== 'custom'

  // ── Ollama model + timeout ──────────────────────────────────────────────────
  const [models,  setModels]  = useState([])
  const [model,   setModel]   = useState('')
  const [timeout, setTimeout_] = useState('')
  const [ollamaStatus, setOllamaStatus] = useState(null)
  const [ollamaErr,    setOllamaErr]    = useState('')
  const modelValue = envDefaultsActive ? llmModelEnvDefault : (llmProvider === 'ollama' ? model : llmModel)
  const modelOptions = [...new Set(
    llmProvider === 'ollama'
      ? [...ollamaModelSuggestions, ...models]
      : [...(providerModels.length ? providerModels : (cloudModelSuggestions[llmProvider] ?? []))]
  )]
  const modelSelectValue = modelChoice || (modelOptions.includes(modelValue) ? modelValue : '__custom__')
  const customModelEntry = llmProvider === 'custom' || modelSelectValue === '__custom__'
  // Show dots whenever a key is known — either saved in DB or present in .env,
  // regardless of whether the "Use .env defaults" checkbox is ticked.
  const savedApiKeyMask = (llmApiKeySet || llmApiKeyEnvSet) ? '••••••••••••' : ''

  // ── Paper trading settings ──────────────────────────────────────────────────
  const [paperEnabled,        setPaperEnabled]        = useState(false)
  const [alpacaUrl,           setAlpacaUrl]           = useState('https://paper-api.alpaca.markets')
  const [alpacaKeyId,         setAlpacaKeyId]         = useState('')
  const [alpacaKeyIdSet,      setAlpacaKeyIdSet]      = useState(false)
  const [showAlpacaKeyId,     setShowAlpacaKeyId]     = useState(false)
  const [alpacaSecret,        setAlpacaSecret]        = useState('')
  const [alpacaSecretSet,     setAlpacaSecretSet]     = useState(false)
  const [showAlpacaSecret,    setShowAlpacaSecret]    = useState(false)
  const [paperPositionSize,   setPaperPositionSize]   = useState(500)
  const [paperMinConf,        setPaperMinConf]        = useState(75)
  const [paperSaveStatus,     setPaperSaveStatus]     = useState(null)
  const [alpacaTestResult,    setAlpacaTestResult]    = useState(null)  // null | {equity,buying_power} | 'error'
  const [alpacaTestLoading,   setAlpacaTestLoading]   = useState(false)
  const [useAlpacaEnvDefaults,setUseAlpacaEnvDefaults]= useState(false)
  const [alpacaKeyIdEnvSet,   setAlpacaKeyIdEnvSet]   = useState(false)
  const [alpacaSecretEnvSet,  setAlpacaSecretEnvSet]  = useState(false)

  const savePaperSettings = async () => {
    setPaperSaveStatus('saving')
    try {
      const body = {
        enabled: paperEnabled,
        paper_url: alpacaUrl,
        position_size: parseFloat(paperPositionSize) || 500,
        min_confidence: parseFloat(paperMinConf) || 75,
      }
      if (useAlpacaEnvDefaults) {
        // Signal the backend to clear DB credentials and fall back to .env vars.
        body.use_env = true
        body.key_id = ''
        body.secret_key = ''
      } else {
        if (alpacaKeyId)  body.key_id    = alpacaKeyId
        if (alpacaSecret) body.secret_key = alpacaSecret
      }
      const r = await fetch(`${API}/settings/alpaca`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      if (!useAlpacaEnvDefaults) {
        if (alpacaKeyId)  setAlpacaKeyIdSet(true)
        if (alpacaSecret) setAlpacaSecretSet(true)
      }
      // Keep Key ID visible after save (it's not secret); clear secret
      setAlpacaSecret('')
      setShowAlpacaSecret(false)
      setPaperSaveStatus('ok')
      setTimeout(() => setPaperSaveStatus(null), 3000)
    } catch (e) {
      setPaperSaveStatus('error')
      setTimeout(() => setPaperSaveStatus(null), 4000)
    }
  }

  const testAlpacaConnection = async () => {
    setAlpacaTestLoading(true)
    setAlpacaTestResult(null)
    try {
      // POST currently-typed credentials so the test works before saving.
      // Empty strings are omitted — backend falls back to DB / env values.
      const body = {}
      if (alpacaUrl)   body.paper_url   = alpacaUrl
      if (alpacaKeyId) body.key_id      = alpacaKeyId
      if (alpacaSecret) body.secret_key = alpacaSecret
      const r = await fetch(`${API}/settings/alpaca/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setAlpacaTestResult(d.account ?? 'error')
    } catch (e) {
      setAlpacaTestResult('error')
    } finally {
      setAlpacaTestLoading(false)
    }
  }

  const revealAlpacaSecret = () => {
    // Key reveal removed for security — keys are write-only from the browser.
    // To verify the current secret, use `fly secrets list` in your terminal.
    setShowAlpacaSecret(v => !v)
  }

  // ── Scheduler + scan interval ───────────────────────────────────────────────
  const [schedulerRunning,  setSchedulerRunning]  = useState(true)
  const [scanInterval,      setScanInterval]      = useState('15')
  const [schedStatus,       setSchedStatus]       = useState(null)
  const [schedErr,          setSchedErr]          = useState('')

  // ── Alerts ──────────────────────────────────────────────────────────────────
  const [alertsOn,     setAlertsOn]     = useState(true)
  const [alertsStatus, setAlertsStatus] = useState(null)

  // ── Data reset ──────────────────────────────────────────────────────────────
  const [resetStatus, setResetStatus] = useState(null)

  // ── Performance / parallelism ────────────────────────────────────────────────
  const [perfSettings,     setPerfSettings]     = useState(null)
  const [perfRateLimits,   setPerfRateLimits]   = useState(null)
  const [concTickers,      setConcTickers]      = useState(4)
  const [concLlm,          setConcLlm]          = useState(2)
  const [perfSaveStatus,   setPerfSaveStatus]   = useState(null)

  const loadPerfSettings = async () => {
    try {
      const r = await fetch(`${API}/settings/performance`, { headers: getAuthHeaders() })
      if (!r.ok) return
      const d = await r.json()
      setPerfSettings(d)
      setPerfRateLimits(d.rate_limits)
      setConcTickers(d.concurrent_tickers ?? 4)
      setConcLlm(d.concurrent_llm ?? 2)
    } catch (e) { /* best-effort */ }
  }

  const savePerfSettings = async () => {
    setPerfSaveStatus('saving')
    try {
      const r = await fetch(
        `${API}/settings/performance?concurrent_tickers=${concTickers}&concurrent_llm=${concLlm}`,
        { method: 'POST' }
      )
      if (!r.ok) throw new Error(await r.text())
      setPerfSaveStatus('ok')
      setTimeout(() => setPerfSaveStatus(null), 3000)
    } catch (e) { setPerfSaveStatus('error') }
  }

  // ── Data cache ──────────────────────────────────────────────────────────────
  const [cacheStats,       setCacheStats]       = useState(null)
  const [cacheStatsErr,    setCacheStatsErr]    = useState(null)
  const [cacheEvictStatus, setCacheEvictStatus] = useState(null)

  const loadCacheStats = async () => {
    setCacheStatsErr(null)
    try {
      const r = await fetch(`${API}/data/cache/stats`, { headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      setCacheStats(await r.json())
    } catch (e) { setCacheStatsErr(String(e)) }
  }

  const evictCache = async (hours) => {
    setCacheEvictStatus('clearing')
    try {
      const r = await fetch(`${API}/data/cache?older_than_hours=${hours}`, { method: 'DELETE', headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setCacheEvictStatus(`ok:${d.deleted}`)
      loadCacheStats()
      setTimeout(() => setCacheEvictStatus(null), 4000)
    } catch (e) { setCacheEvictStatus('error') }
  }

  // Load on mount
  useEffect(() => {
    Promise.all([
      fetch(`${API}/settings`, { headers: getAuthHeaders() }).then(r => r.json()),
      fetch(`${API}/settings/models`, { headers: getAuthHeaders() }).then(r => r.json()),
    ]).then(([cfg, m]) => {
      // LLM provider
      setLlmProvider(cfg.llm_provider ?? 'ollama')
      setLlmApiKeySet(cfg.llm_api_key_set ?? false)
      setLlmModel(cfg.llm_model ?? '')
      setLlmBaseUrl(cfg.llm_base_url ?? '')
      setLlmModelEnvDefault(cfg.llm_model_env_default ?? '')
      setLlmBaseUrlEnvDefault(cfg.llm_base_url_env_default ?? '')
      setLlmApiKeyEnvSet(cfg.llm_api_key_env_set ?? false)
      setLlmReasoningEffort(cfg.llm_reasoning_effort ?? 'none')
      // Ollama
      setModel(cfg.ollama_model ?? '')
      setTimeout_(String(cfg.ollama_timeout ?? 120))
      setModels(m.provider === 'ollama' ? (m.models ?? []) : [])
      setProviderModels(m.provider === 'ollama' ? [] : (m.models ?? []))
      // Other
      setScanInterval(String(cfg.scan_interval_minutes ?? 15))
      setSchedulerRunning(cfg.scheduler_running ?? true)
      setAlertsOn(cfg.alerts_enabled ?? true)
      setSignalLlmEnabled(cfg.signal_scan_llm_enabled ?? true)
      // Paper trading
      setPaperEnabled(cfg.paper_trading_enabled ?? false)
      setAlpacaUrl(cfg.alpaca_paper_url ?? 'https://paper-api.alpaca.markets')
      setAlpacaKeyId(cfg.alpaca_key_id ?? '')          // pre-fill; Key ID is not secret
      setAlpacaKeyIdSet(cfg.alpaca_key_id_set ?? false)
      setAlpacaSecretSet(cfg.alpaca_secret_set ?? false)
      setAlpacaKeyIdEnvSet(cfg.alpaca_key_id_env_set ?? false)
      setAlpacaSecretEnvSet(cfg.alpaca_secret_env_set ?? false)
      setPaperPositionSize(cfg.paper_trade_position_size ?? 500)
      if (cfg.paper_trade_min_confidence != null) setPaperMinConf(cfg.paper_trade_min_confidence)
    }).catch(() => {})
    loadCacheStats()
    loadPerfSettings()
  }, [])

  const loadProviderSettings = async (provider) => {
    const query = `?provider=${encodeURIComponent(provider)}`
    const [cfg, modelData] = await Promise.all([
      fetch(`${API}/settings${query}`, { headers: getAuthHeaders() }).then(r => r.json()),
      fetch(`${API}/settings/models${query}`, { headers: getAuthHeaders() }).then(r => r.json()),
    ])
    setLlmApiKeySet(cfg.llm_api_key_set ?? false)
    setLlmModel(cfg.llm_model ?? '')
    setLlmBaseUrl(cfg.llm_base_url ?? '')
    setLlmModelEnvDefault(cfg.llm_model_env_default ?? '')
    setLlmBaseUrlEnvDefault(cfg.llm_base_url_env_default ?? '')
    setLlmApiKeyEnvSet(cfg.llm_api_key_env_set ?? false)
    setLlmReasoningEffort(cfg.llm_reasoning_effort ?? 'none')
    setLlmFallbackProvider(cfg.llm_fallback_provider ?? '')
    setLlmFallbackModel(cfg.llm_fallback_model ?? '')
    if (provider === 'ollama') setModels(modelData.models ?? [])
    else setProviderModels(modelData.models ?? [])
  }

  const saveLlm = async () => {
    setLlmStatus('saving'); setLlmErr('')
    try {
      const body = { provider: llmProvider }
      if (envDefaultsActive) {
        body.api_key = ''
        body.model = ''
        body.base_url = ''
      } else {
        if (llmApiKey)  body.api_key  = llmApiKey
        if (llmModel)   body.model    = llmModel
        if (llmBaseUrl) body.base_url = llmBaseUrl
      }
      if (supportsReasoning) body.reasoning_effort = llmReasoningEffort
      body.fallback_provider = llmFallbackProvider
      body.fallback_model    = llmFallbackModel
      const r = await fetch(`${API}/settings/llm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      if (llmApiKey) { setLlmApiKey(''); setLlmApiKeySet(true) }
      if (envDefaultsActive) { setLlmApiKeySet(false); setLlmModel(''); setLlmBaseUrl('') }
      setLlmStatus('ok')
      onHealthRefresh?.()   // refresh header chip immediately — no page reload needed
      setTimeout(() => setLlmStatus(null), 3000)
    } catch (e) { setLlmStatus('error'); setLlmErr(e.message) }
  }

  const saveOllama = async () => {
    setOllamaStatus('saving'); setOllamaErr('')
    try {
      const body = {}
      body.model = useEnvDefaults ? '' : model
      if (timeout) body.timeout = parseInt(timeout, 10)
      const r = await fetch(`${API}/settings/ollama`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      setOllamaStatus('ok')
      onHealthRefresh?.()   // refresh header chip immediately — no page reload needed
      setTimeout(() => setOllamaStatus(null), 3000)
    } catch (e) { setOllamaStatus('error'); setOllamaErr(e.message) }
  }

  const saveScheduler = async () => {
    setSchedStatus('saving'); setSchedErr('')
    try {
      await fetch(`${API}/settings/scan-interval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ minutes: parseInt(scanInterval, 10) }),
      })
      setSchedStatus('ok')
      setTimeout(() => setSchedStatus(null), 3000)
    } catch (e) { setSchedStatus('error'); setSchedErr(e.message) }
  }

  const toggleScheduler = async () => {
    const next = !schedulerRunning
    setSchedulerRunning(next)          // optimistic update
    try {
      const r = await fetch(`${API}/settings/scheduler`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ running: next }),
      })
      if (r.ok) {
        const data = await r.json()
        setSchedulerRunning(data.running ?? next)   // reconcile with server
      } else {
        setSchedulerRunning(!next)                  // revert on error
      }
    } catch (e) { setSchedulerRunning(!next) }      // revert on network error
  }

  const toggleAlerts = async () => {
    const next = !alertsOn
    try {
      await fetch(`${API}/settings/alerts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ enabled: next }),
      })
      setAlertsOn(next)
      setAlertsStatus('ok')
      setTimeout(() => setAlertsStatus(null), 2000)
    } catch (e) { /* best-effort */ }
  }

  const resetData = async () => {
    if (!window.confirm('Clear ALL signals and analysis history? App settings (watchlist, model, interval) will be preserved. This cannot be undone.')) return
    setResetStatus('clearing')
    try {
      const r = await fetch(`${API}/data/reset`, { method: 'POST', headers: getAuthHeaders() })
      if (!r.ok) throw new Error(await r.text())
      setResetStatus('ok')
      setTimeout(() => setResetStatus(null), 4000)
    } catch (e) { setResetStatus('error') }
  }

  return (
    <div className="settings-layout">
      {/* ── Sticky TOC sidebar ─────────────────────────────────────────────── */}
      <nav className="settings-toc">
        <div className="settings-toc-title">Settings</div>
        {SETTINGS_SECTIONS.map(s => (
          <button
            key={s.id}
            className="settings-toc-link"
            onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {s.icon} {s.label}
          </button>
        ))}
      </nav>

      <div className="settings-page">

      {/* ── Signal Configuration ──────────────────────────────────────────── */}
      <SettingSection id="settings-signal" title="Signal Configuration" icon="📡">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 18 }}>
          Control how the system scans for signals: when it runs, who gets notified,
          and whether AI analysis is applied.
        </p>

        {/* ─ Scheduler ─ */}
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 10 }}>⏰ Scheduler</div>

        <div className="settings-row">
          <div className="settings-row-label">
            <span>Auto-scan</span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {schedulerRunning ? 'Running — scanning on schedule' : 'Stopped — manual runs only'}
            </span>
          </div>
          <button
            className={`settings-toggle ${schedulerRunning ? 'on' : 'off'}`}
            onClick={toggleScheduler}
            title={schedulerRunning ? 'Stop scheduler' : 'Start scheduler'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="settings-row" style={{ marginTop: 12 }}>
          <div className="settings-row-label">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Scan interval
              <InfoTip text="How often the scheduler automatically re-analyses every ticker on your watchlist. Lower = more frequent, more LLM tokens used." />
            </span>
            <span className="text-dim" style={{ fontSize: 12 }}>Minutes between automatic scans</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="number" min={1} max={1440}
              value={scanInterval}
              onChange={e => setScanInterval(e.target.value)}
              className="settings-num-input"
            />
            <span className="text-dim" style={{ fontSize: 13 }}>min</span>
          </div>
        </div>
        <SaveRow status={schedStatus} errMsg={schedErr} onSave={saveScheduler} label="Apply interval" />

        <div style={{ borderTop: '1px solid var(--border)', margin: '18px 0', opacity: 0.4 }} />

        {/* ─ Alerts ─ */}
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 10 }}>🔔 Alerts</div>

        <div className="settings-row">
          <div className="settings-row-label">
            <span>Alert dispatch</span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {alertsOn ? 'Enabled — alerts sent on actionable signals (email / Slack / Telegram)' : 'Suppressed — all alert channels silenced'}
            </span>
          </div>
          <button
            className={`settings-toggle ${alertsOn ? 'on' : 'off'}`}
            onClick={toggleAlerts}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {alertsStatus === 'ok' && (
          <div className="settings-ok" style={{ marginTop: 8 }}>✓ Updated</div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', margin: '18px 0', opacity: 0.4 }} />

        {/* ─ AI Analysis ─ */}
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 10 }}>🤖 AI Analysis</div>

        <div className="settings-row">
          <div className="settings-row-label">
            <span style={{ color: signalLlmEnabled ? undefined : 'var(--dim)' }}>
              {signalLlmEnabled ? 'LLM enabled' : 'Rules-only (LLM disabled)'}
            </span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {signalLlmEnabled
                ? 'AI analysis runs on every scan and on-demand call — consumes provider quota'
                : 'LLM skill skipped globally — no API quota used during signal scanning'}
            </span>
          </div>
          <button
            className={`settings-toggle ${signalLlmEnabled ? 'on' : 'off'}`}
            onClick={() => saveSignalLlmEnabled(!signalLlmEnabled)}
            disabled={signalLlmSaveStatus === 'saving'}
            title={signalLlmEnabled ? 'Click to disable LLM for signal scanning' : 'Click to enable LLM for signal scanning'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {signalLlmSaveStatus === 'saving' && <span style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8, display: 'block' }}>Saving…</span>}
        {signalLlmSaveStatus === 'ok'     && <span className="settings-ok" style={{ marginTop: 8, display: 'block' }}>✓ Saved</span>}
        {signalLlmSaveStatus === 'error'  && <span className="settings-err" style={{ marginTop: 8, display: 'block' }}>✗ Failed</span>}
      </SettingSection>

      {/* ── Paper Trading ─────────────────────────────────────────────────── */}
      <SettingSection id="settings-paper" title="Paper Trading" icon="📈">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 16 }}>
          Automatically place bracket orders on your <strong>Alpaca paper account</strong> whenever
          an actionable signal fires. No real money is involved — paper trading is a free simulation.
          Get API keys at <a href="https://app.alpaca.markets/paper-trading" target="_blank" rel="noreferrer"
            style={{ color: 'var(--accent)' }}>app.alpaca.markets</a>.
        </p>

        {/* Enable toggle */}
        <div className="settings-row" style={{ marginBottom: 18 }}>
          <div className="settings-row-label">
            <span style={{ fontWeight: 600 }}>
              {paperEnabled ? '📈 Paper trading active' : 'Paper trading disabled'}
            </span>
            <span className="text-dim" style={{ fontSize: 12 }}>
              {paperEnabled
                ? 'Bracket orders placed automatically on each actionable signal'
                : 'Toggle on to start placing paper orders automatically'}
            </span>
          </div>
          <button className={`settings-toggle ${paperEnabled ? 'on' : 'off'}`}
                  onClick={() => setPaperEnabled(v => !v)}>
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 12 }}>🔑 Alpaca Connection</div>

        <button
          type="button"
          className={`settings-env-btn${useAlpacaEnvDefaults ? ' active' : ''}`}
          onClick={() => {
            setUseAlpacaEnvDefaults(v => !v)
            setAlpacaKeyId('')
            setAlpacaSecret('')
            setShowAlpacaSecret(false)
          }}
        >
          {useAlpacaEnvDefaults ? '✓ Using environment defaults' : '↩ Load Environment Default Values'}
          <span className="settings-env-btn-sub">
            {useAlpacaEnvDefaults
              ? '(click to clear and enter values manually)'
              : '(if set in .env — ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY)'}
          </span>
        </button>

        <div className="settings-field" style={{ marginBottom: 12, marginTop: 12 }}>
          <label className="settings-label">Paper API URL</label>
          <input type="text" value={alpacaUrl} onChange={e => setAlpacaUrl(e.target.value)}
                 className="settings-select" placeholder="https://paper-api.alpaca.markets"
                 style={{ marginTop: 4 }} />
        </div>

        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label className="settings-label">API Key ID</label>
          <div className="settings-secret-field" style={{ marginTop: 4 }}>
            <input
              type={showAlpacaKeyId ? 'text' : 'password'}
              value={useAlpacaEnvDefaults ? '' : (alpacaKeyId || (alpacaKeyIdSet && !showAlpacaKeyId ? '••••••••••••' : ''))}
              onFocus={() => { if (!alpacaKeyId && alpacaKeyIdSet) setAlpacaKeyId('') }}
              onChange={e => setAlpacaKeyId(e.target.value)}
              disabled={useAlpacaEnvDefaults}
              className="settings-select"
              autoComplete="new-password"
              placeholder={
                useAlpacaEnvDefaults
                  ? (alpacaKeyIdEnvSet ? 'Using Key ID from .env' : 'No Key ID set in .env')
                  : (alpacaKeyIdSet ? 'Key saved — focus to replace' : 'PKxxxxxxxxxxxxxxxxxxxxxx')
              }
            />
            <button type="button" className="settings-secret-toggle"
                    disabled={useAlpacaEnvDefaults}
                    onClick={() => setShowAlpacaKeyId(v => !v)}>
              {showAlpacaKeyId ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <div className="settings-field" style={{ marginBottom: 16 }}>
          <label className="settings-label">API Secret Key</label>
          <div className="settings-secret-field" style={{ marginTop: 4 }}>
            <input type={showAlpacaSecret ? 'text' : 'password'}
                   value={useAlpacaEnvDefaults ? '' : (alpacaSecret || (alpacaSecretSet && !showAlpacaSecret ? '••••••••••••' : ''))}
                   onFocus={() => { if (!alpacaSecret && alpacaSecretSet) setAlpacaSecret('') }}
                   onChange={e => setAlpacaSecret(e.target.value)}
                   disabled={useAlpacaEnvDefaults}
                   className="settings-select"
                   placeholder={
                     useAlpacaEnvDefaults
                       ? (alpacaSecretEnvSet ? 'Using Secret from .env' : 'No Secret set in .env')
                       : (alpacaSecretSet ? 'Secret saved — focus to replace' : 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
                   } />
            <button type="button" className="settings-secret-toggle"
                    disabled={useAlpacaEnvDefaults}
                    onClick={() => {
                      if (showAlpacaSecret) { setAlpacaSecret(''); setShowAlpacaSecret(false) }
                      else { revealAlpacaSecret() }
                    }}>
              {showAlpacaSecret ? 'Hide' : 'Show'}
            </button>
          </div>
          {!useAlpacaEnvDefaults && alpacaSecretSet && !alpacaSecret && (
            <span className="text-dim" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
              ✓ Secret is set — to verify the value, use <code className="inline-code">fly secrets list</code>
            </span>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0 16px', opacity: 0.4 }} />
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase',
                      letterSpacing: '0.09em', marginBottom: 12 }}>💵 Trade Sizing</div>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
          <div className="settings-field">
            <label className="settings-label" title="Fixed dollar amount invested per signal">
              Position size per trade
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span style={{ color: 'var(--dim)', fontSize: 13 }}>$</span>
              <input type="number" min={1} step={50} value={paperPositionSize}
                     onChange={e => setPaperPositionSize(e.target.value)}
                     className="settings-num-input" style={{ width: 100 }} />
            </div>
          </div>
          <div className="settings-field" style={{ minWidth: 200 }}>
            <label className="settings-label"
                   title="Minimum signal confidence to place an order (can be set higher than the alert floor)">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Min confidence to trade: <strong>{paperMinConf}%</strong>
                <InfoTip text="Signals below this score are ignored and won't trigger alerts or paper trades. Raise it to reduce noise; lower it to catch more signals." />
              </span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <input type="range" min={0} max={100} step={5} value={paperMinConf}
                     onChange={e => setPaperMinConf(Number(e.target.value))}
                     className="filter-range" style={{ flex: 1 }} />
              <span className="filter-val">{paperMinConf}%</span>
            </div>
          </div>
        </div>

        {/* Save + Test Connection side-by-side with status messages */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <button className="btn-primary btn-sm" onClick={savePaperSettings}
                  disabled={paperSaveStatus === 'saving'}>
            {paperSaveStatus === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <button className="btn-secondary btn-sm" onClick={testAlpacaConnection}
                  disabled={alpacaTestLoading}>
            {alpacaTestLoading ? 'Testing…' : 'Test Connection'}
          </button>
          {paperSaveStatus === 'ok'    && <span className="settings-ok">✓ Saved</span>}
          {paperSaveStatus === 'error' && <span className="settings-err">✗ Save failed</span>}
          {alpacaTestResult && alpacaTestResult !== 'error' && (
            <span className="settings-ok" style={{ fontSize: 12 }}>
              ✓ Connected · Equity ${parseFloat(alpacaTestResult.equity ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          )}
          {alpacaTestResult === 'error' && (
            <span className="settings-err" style={{ fontSize: 12 }}>✗ Connection failed — check credentials</span>
          )}
        </div>
      </SettingSection>

      {/* ── AI Provider ───────────────────────────────────────────────────── */}
      <SettingSection id="settings-ai-provider" title="AI Provider" icon="🧠">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Choose where AI analysis runs. <strong>Ollama</strong> is local (no internet, needs GPU/RAM).
          <strong> Groq</strong>, <strong>Gemini</strong>, and <strong>Mistral</strong> are cloud APIs.
          Changes take effect immediately, no restart needed.
        </p>

        <div className="settings-field">
          <label className="settings-label">Provider</label>
          <select
            value={llmProvider}
            onChange={e => {
              // Reset per-provider fields so a model/key typed for one
              // provider can never be silently saved against another.
              const provider = e.target.value
              setLlmProvider(provider)
              setUseEnvDefaults(false)
              setModelChoice('')
              setLlmModel('')
              setLlmApiKey('')
              setLlmBaseUrl('')
              setLlmApiKeySet(false)
              setLlmReasoningEffort('none')
              loadProviderSettings(provider).catch(() => {})
            }}
            className="settings-select"
          >
            <option value="ollama">🖥️ Ollama (local)</option>
            <option value="groq">⚡ Groq Cloud — free · console.groq.com</option>
            <option value="gemini">✨ Google Gemini — free · ai.google.dev</option>
            <option value="mistral">🌬️ Mistral AI · console.mistral.ai</option>
            <option value="custom">🔧 Custom OpenAI-compatible endpoint</option>
          </select>
        </div>

        {llmProvider !== 'custom' && (
          <button
            type="button"
            className={`settings-env-btn${useEnvDefaults ? ' active' : ''}`}
            onClick={() => {
              setUseEnvDefaults(v => !v)
              setLlmApiKey('')
              setShowLlmApiKey(false)
            }}
          >
            {useEnvDefaults ? '✓ Using environment defaults' : '↩ Load Environment Default Values'}
            <span className="settings-env-btn-sub">
              {useEnvDefaults ? '(click to clear and enter values manually)' : '(if set in .env — can be empty)'}
            </span>
          </button>
        )}

        {llmProvider !== 'ollama' && (
          <>
            <div className="settings-field">
              <label className="settings-label">API Key</label>
              <div className="settings-secret-field">
                <input
                  type={showLlmApiKey ? 'text' : 'password'}
                  value={llmApiKey || savedApiKeyMask}
                  onFocus={() => { if (!llmApiKey && savedApiKeyMask) setLlmApiKey('') }}
                  onChange={e => setLlmApiKey(e.target.value)}
                  disabled={envDefaultsActive}
                  placeholder={
                    envDefaultsActive
                      ? (llmApiKeyEnvSet ? 'Using key from .env' : 'No key set in .env')
                      : (llmApiKeySet ? 'Key saved — focus to replace it' : 'Paste your API key here')
                  }
                  className="settings-select"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="settings-secret-toggle"
                  onClick={() => setShowLlmApiKey(v => !v)}
                  title={showLlmApiKey ? 'Hide API key' : 'Show/hide typed key'}
                  aria-label={showLlmApiKey ? 'Hide API key' : 'Show API key'}
                >
                  {showLlmApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
              {!envDefaultsActive && llmApiKeySet && !llmApiKey && (
                <span className="text-dim" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                  ✓ API key is set — to rotate it, paste a new key above and save
                </span>
              )}
            </div>

            <div className="settings-field">
              <label className="settings-label">
                Model
                <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>(select or type a model ID)</span>
              </label>
              {llmProvider !== 'custom' && !customModelEntry && (
                <select
                  value={envDefaultsActive ? modelValue : modelSelectValue}
                  onChange={e => {
                    const value = e.target.value
                    setModelChoice(value)
                    if (value !== '__custom__') setLlmModel(value)
                  }}
                  disabled={envDefaultsActive}
                  className="settings-select"
                >
                  {modelOptions.map(modelOption => <option key={modelOption} value={modelOption}>{modelOption}</option>)}
                  <option value="__custom__">— type your own model —</option>
                </select>
              )}
              {(llmProvider === 'custom' || customModelEntry) && (
                <>
                  {customModelEntry && llmProvider !== 'custom' && (
                    <button
                      type="button"
                      className="settings-back-link"
                      onClick={() => {
                        const first = modelOptions[0] ?? ''
                        setModelChoice(first)
                        setLlmModel(first)
                      }}
                    >
                      ← back to model list
                    </button>
                  )}
                  <input
                    type="text"
                    value={envDefaultsActive ? modelValue : llmModel}
                    onChange={e => setLlmModel(e.target.value)}
                    disabled={envDefaultsActive}
                    placeholder="Type a model ID"
                    className="settings-select"
                  />
                </>
              )}
            </div>

            {supportsReasoning && (
              <div className="settings-field">
                <label className="settings-label">
                  Reasoning effort
                  <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>(only used by models that support it)</span>
                </label>
                <select
                  value={llmReasoningEffort}
                  onChange={e => setLlmReasoningEffort(e.target.value)}
                  className="settings-select"
                >
                  {REASONING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            )}

            {llmProvider === 'custom' && (
              <div className="settings-field">
                <label className="settings-label">Base URL</label>
                <input
                  type="text"
                  value={llmBaseUrl}
                  onChange={e => setLlmBaseUrl(e.target.value)}
                  placeholder="https://your-host/v1"
                  className="settings-select"
                />
              </div>
            )}
          </>
        )}

        {llmProvider === 'ollama' && (
          <>
            <div className="settings-field">
              <label className="settings-label">Model</label>
              {!customModelEntry && (
                <select
                  value={envDefaultsActive ? modelValue : modelSelectValue}
                  onChange={e => {
                    const value = e.target.value
                    setModelChoice(value)
                    if (value !== '__custom__') setModel(value)
                  }}
                  disabled={envDefaultsActive}
                  className="settings-select"
                >
                  {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
                  <option value="__custom__">— type your own model —</option>
                </select>
              )}
              {customModelEntry && (
                <>
                  <button
                    type="button"
                    className="settings-back-link"
                    onClick={() => {
                      const first = modelOptions[0] ?? ''
                      setModelChoice(first)
                      setModel(first)
                    }}
                  >
                    ← back to model list
                  </button>
                  <input
                    type="text"
                    value={envDefaultsActive ? modelValue : model}
                    onChange={e => setModel(e.target.value)}
                    disabled={envDefaultsActive}
                    placeholder="Type an Ollama model tag"
                    className="settings-select"
                  />
                </>
              )}
            </div>
            <div className="settings-field">
              <label className="settings-label">Request timeout</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" min={10} max={3600} value={timeout}
                  onChange={e => setTimeout_(e.target.value)} className="settings-num-input" />
                <span className="text-dim" style={{ fontSize: 13 }}>seconds</span>
              </div>
            </div>
            <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>
              Match model size to GPU VRAM: 3b ≈ 3 GB · 7b ≈ 5 GB · 14b ≈ 10 GB.
              Pull new models: <code className="inline-code">docker exec ollama ollama pull &lt;model&gt;</code>
            </p>
          </>
        )}

        {/* ── Fallback provider (auto-used on HTTP 429 / quota) ──────────── */}
        <div className="settings-field" style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <label className="settings-label">
            Fallback provider
            <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>
              (auto-used when primary returns quota / HTTP 429)
            </span>
          </label>
          <select
            value={llmFallbackProvider}
            onChange={e => setLlmFallbackProvider(e.target.value)}
            className="settings-select"
          >
            <option value="">— disabled —</option>
            <option value="ollama">🖥️ Ollama (local)</option>
            <option value="groq">⚡ Groq Cloud</option>
            <option value="gemini">✨ Google Gemini</option>
            <option value="mistral">🌬️ Mistral AI</option>
            <option value="custom">🔧 Custom endpoint</option>
          </select>
        </div>
        {llmFallbackProvider && llmFallbackProvider !== llmProvider && (
          <div className="settings-field">
            <label className="settings-label">
              Fallback model
              <span className="text-dim" style={{ fontSize: 12, marginLeft: 6 }}>(leave blank for provider default)</span>
            </label>
            <input
              type="text"
              value={llmFallbackModel}
              onChange={e => setLlmFallbackModel(e.target.value)}
              placeholder="e.g. gemini-3.5-flash-lite"
              className="settings-select"
            />
          </div>
        )}

        <SaveRow
          status={llmStatus} errMsg={llmErr}
          onSave={llmProvider === 'ollama' ? saveOllama : saveLlm}
          label="Save AI provider settings"
        />
      </SettingSection>

      {/* ── AI Usage ─────────────────────────────────────────────────────── */}
      <SettingSection id="settings-usage" title="AI Usage" icon="⚡">
        <UsageSection usage={usage} onRefresh={onUsageRefresh} />
      </SettingSection>

      {/* ── Performance ───────────────────────────────────────────────────── */}
      <SettingSection id="settings-perf" title="Performance" icon="🚀">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Control parallelism for <strong>both live signal scanning and backtesting</strong>.
          Higher concurrency finishes faster but must stay within provider rate limits.
          Changes take effect immediately — no restart needed.
        </p>

        {/* Sliders */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Concurrent tickers</label>
              <span style={{ fontSize: 10, background: 'var(--accent)', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>Signals</span>
              <span style={{ fontSize: 10, background: 'var(--accent)', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>Backtest</span>
              <span style={{ fontWeight: 700, color: 'var(--accent)', minWidth: 24, textAlign: 'right' }}>{concTickers}</span>
            </div>
            <input type="range" min={1} max={20} value={concTickers}
              onChange={e => setConcTickers(Number(e.target.value))}
              style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
              <span>1 (sequential)</span><span>4 (default)</span><span>20</span>
            </div>
            <p className="text-dim" style={{ fontSize: 12, marginTop: 6 }}>
              How many tickers are analysed simultaneously. For <strong>signals</strong>: the
              scheduler's concurrency cap (controls how many TickerAgent calls run at once, each
              making one LLM call). For <strong>backtests</strong>: the replay thread pool size.
              With the OHLCV cache most data is instant — 4–8 is a good range.
            </p>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Concurrent LLM calls</label>
              <span style={{ fontSize: 10, background: 'var(--dim)', color: 'var(--bg)', borderRadius: 4, padding: '1px 6px' }}>Backtest only</span>
              <span style={{ fontWeight: 700, color: 'var(--accent)', minWidth: 24, textAlign: 'right' }}>{concLlm}</span>
            </div>
            <input type="range" min={1} max={10} value={concLlm}
              onChange={e => setConcLlm(Number(e.target.value))}
              style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
              <span>1</span><span>2 (default)</span><span>10</span>
            </div>
            <p className="text-dim" style={{ fontSize: 12, marginTop: 6 }}>
              Backtest LLM mode only. Max LLM requests in-flight simultaneously across all
              ticker threads. Signals don't need this — each TickerAgent already maps to one LLM
              call, so <em>Concurrent tickers</em> above is the effective limit for signals.
              Keep this ≤ your provider's RPM ÷ 15 to stay within rate limits.
            </p>
          </div>
        </div>

        <div className="settings-save-row" style={{ marginBottom: 20 }}>
          <button className="btn-primary btn-sm" onClick={savePerfSettings} disabled={perfSaveStatus === 'saving'}>
            {perfSaveStatus === 'saving' ? 'Saving…' : 'Save defaults'}
          </button>
          {perfSaveStatus === 'ok'    && <span className="settings-ok">✓ Saved</span>}
          {perfSaveStatus === 'error' && <span className="settings-err">✗ Save failed</span>}
        </div>

        {/* Rate limits reference */}
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>Rate limit reference</div>
        <table style={{ fontSize: 12, color: 'var(--dim)', borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', paddingBottom: 4, paddingRight: 16, color: 'var(--fg)' }}>Source</th>
              <th style={{ textAlign: 'left', paddingBottom: 4, color: 'var(--fg)' }}>Limit</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['yfinance', 'No official limit — 3–4 concurrent safe. Cache makes most calls instant.'],
              ['Finnhub (news)', '60 req/min free tier. Date-keyed cache = 1 call/ticker/day max.'],
              ['Gemini free', '15 RPM · 1 500 RPD · 1M TPM'],
              ['Groq', '30–60 RPM (model-dependent) — check console.groq.com'],
              ['OpenAI', 'Tier-dependent — check platform.openai.com/usage'],
              ['Mistral', '30 RPM · 500 RPD'],
              ['Ollama', 'Local inference — no external rate limits'],
            ].map(([src, lim]) => (
              <tr key={src}>
                <td style={{ padding: '4px 16px 4px 0', whiteSpace: 'nowrap', fontWeight: 500, color: 'var(--fg)' }}>{src}</td>
                <td style={{ padding: '4px 0' }}>{lim}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingSection>

      {/* ── Discovery ────────────────────────────────────────────────────── */}
      <DiscoverySettingsSection />

      <SettingSection id="settings-cache" title="Data Cache" icon="💾">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Every market data fetch is stored permanently in the local database, keyed by
          ticker and date. The price, indicator, and news snapshot from each trading day
          is preserved exactly as seen — so backtests can replay the same market state
          without making network calls. OHLCV bars for completed sessions never change.
        </p>

        {/* Stats row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          {cacheStats ? (
            <>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', minWidth: 120, textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{cacheStats.entry_count}</div>
                <div style={{ fontSize: 11, color: 'var(--dim)' }}>cache entries</div>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', minWidth: 120, textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{cacheStats.total_kb} KB</div>
                <div style={{ fontSize: 11, color: 'var(--dim)' }}>stored</div>
              </div>
              {cacheStats.oldest && (
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>
                  Oldest: {cacheStats.oldest?.slice(0, 16).replace('T', ' ')}<br />
                  Newest: {cacheStats.newest?.slice(0, 16).replace('T', ' ')}
                </div>
              )}
              <button className="btn-sm" style={{ marginLeft: 'auto' }} onClick={loadCacheStats}>↻ Refresh</button>
            </>
          ) : cacheStatsErr ? (
            <span className="settings-err" style={{ fontSize: 12 }}>⚠ Could not load cache stats</span>
          ) : (
            <span className="text-dim" style={{ fontSize: 12 }}>Loading…</span>
          )}
        </div>

        {/* TTL reference */}
        <table style={{ fontSize: 12, color: 'var(--dim)', borderCollapse: 'collapse', marginBottom: 16, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 4, paddingRight: 16, color: 'var(--fg)' }}>Data type</th>
              <th style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 4, color: 'var(--fg)' }}>Cache TTL</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Price + fundamentals', '♾ Permanent (keyed by date)'],
              ['Technical indicators (RSI, MACD, …)', '♾ Permanent (keyed by date)'],
              ['News headlines (Finnhub)', '♾ Permanent (keyed by date)'],
              ['OHLCV bars (all windows)', '♾ Permanent (keyed by start/end/interval)'],
              ['Macro data (FRED / CAPE)', '6 hours / 24 hours (global, rarely changes)'],
              ['Balance sheet', '24 hours (daily, quarterly filings)'],
            ].map(([label, ttl]) => (
              <tr key={label}>
                <td style={{ padding: '3px 16px 3px 0' }}>{label}</td>
                <td style={{ padding: '3px 0', color: ttl.startsWith('♾') ? 'var(--green)' : undefined }}>{ttl}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Evict controls */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn-sm" onClick={() => evictCache(168)} disabled={cacheEvictStatus === 'clearing'}>
            Clear entries &gt; 7 days
          </button>
          <button className="btn-sm" onClick={() => evictCache(24)} disabled={cacheEvictStatus === 'clearing'}>
            Clear entries &gt; 24 h
          </button>
          <button className="btn-danger btn-sm" onClick={() => evictCache(1)} disabled={cacheEvictStatus === 'clearing'}>
            Clear all cache
          </button>
          {cacheEvictStatus === 'clearing' && <span className="text-dim" style={{ fontSize: 12 }}>Clearing…</span>}
          {cacheEvictStatus?.startsWith('ok:') && (
            <span className="settings-ok">✓ {cacheEvictStatus.split(':')[1]} entries removed</span>
          )}
          {cacheEvictStatus === 'error' && <span className="settings-err">✗ Evict failed</span>}
        </div>
      </SettingSection>

      {/* ── Data ──────────────────────────────────────────────────────────── */}
      <SettingSection id="settings-data" title="Data" icon="🗑️">
        <p className="text-dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Clear all stored signals and analysis history. App settings (watchlist,
          interval, model, alerts) are preserved. This cannot be undone.
        </p>
        <div className="settings-save-row">
          <button className="btn-danger btn-sm" onClick={resetData} disabled={resetStatus === 'clearing'}>
            {resetStatus === 'clearing' ? 'Clearing…' : 'Clear all data'}
          </button>
          {resetStatus === 'ok'    && <span className="settings-ok">✓ All signals and analyses cleared</span>}
          {resetStatus === 'error' && <span className="settings-err">✗ Reset failed — see backend logs</span>}
        </div>
      </SettingSection>

      </div>
    </div>
  )
}
