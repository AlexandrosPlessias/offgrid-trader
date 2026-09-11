import { fmtTokens } from '../../utils/fmt'

export default function Header({ health, usage, btTodayTokens = 0, activeView, onViewChange, clock }) {
  const ok   = health?.status === 'ok'
  const open = health?.scheduler?.market_open

  // Countdown helper shared with the header market pill
  const fmtCountdown = (isoStr) => {
    if (!isoStr) return null
    const diffMs = new Date(isoStr) - Date.now()
    if (diffMs <= 0) return null
    const totalMin = Math.floor(diffMs / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  const closeIn = clock?.is_open  && clock?.next_close ? fmtCountdown(clock.next_close) : null
  const openIn  = !clock?.is_open && clock?.next_open  ? fmtCountdown(clock.next_open)  : null

  // Model label — provider + model from /health
  const provider  = health?.llm_provider ?? null
  const modelName = health?.llm_model    ?? health?.ollama_model ?? null
  const modelLabel = provider && provider !== 'ollama'
    ? `${provider} · ${modelName ?? '—'}`
    : (modelName ?? null)

  // Token label — filter to the active provider+model so the chip reflects
  // usage for the currently selected model only, not all providers combined.
  const today = new Date().toISOString().slice(0, 10)
  const activeProvider = usage?.active_provider ?? null
  const activeModel    = usage?.active_model    ?? null
  // by_model_day rows: { day, provider, model, prompt_tokens, completion_tokens }
  const modelTodayTokens = (() => {
    if (!usage?.by_model_day) {
      // fallback: use the combined by_day total
      return usage?.by_day?.find(d => d.date === today)?.total_tokens ?? 0
    }
    return (usage.by_model_day
      .filter(r =>
        r.day === today &&
        (!activeProvider || r.provider === activeProvider) &&
        (!activeModel    || r.model    === activeModel)
      )
      .reduce((s, r) => s + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0), 0)
    )
  })()
  // by_model_day already includes backtest + signal + advisor + compare tokens
  // (the /usage endpoint UNIONs all sources). Do NOT add btTodayTokens here —
  // that would double-count backtest runs that are already in modelTodayTokens.
  const todayTokens = modelTodayTokens
  // For tooltip: all-providers combined today total
  const todayEntry = usage?.by_day?.find(d => d.date === today)

  return (
    <header className="header">

      {/* ── Row 1: logo · nav tabs · tools ─────────────────────────────────── */}
      <div className="header-row">
        <div className="header-left">
          <span className="logo">MarketSage</span>
          <nav className="header-nav">
            <button
              className={`nav-tab ${activeView === 'dashboard' ? 'active' : ''}`}
              onClick={() => onViewChange('dashboard')}
            >
              Dashboard
            </button>
            <button
              className={`nav-tab ${activeView === 'paper' ? 'active' : ''}`}
              onClick={() => onViewChange('paper')}
            >
              Trading
            </button>
            <button
              className={`nav-tab ${activeView === 'trending' ? 'active' : ''}`}
              onClick={() => onViewChange('trending')}
            >
              Discovery
            </button>
            <button
              className={`nav-tab ${activeView === 'explorer' ? 'active' : ''}`}
              onClick={() => onViewChange('explorer')}
            >
              Explorer
            </button>
            <button
              className={`nav-tab ${activeView === 'education' ? 'active' : ''}`}
              onClick={() => onViewChange('education')}
            >
              Learn
            </button>
          </nav>
        </div>
        <div className="header-right">
          <div className="header-tools">
            <button
              className={`nav-tab ${activeView === 'backtest' ? 'active' : ''}`}
              onClick={() => onViewChange('backtest')}
              style={{ fontSize: 12 }}
            >
              Backtesting
            </button>
            <a href="http://localhost:18889" target="_blank" rel="noreferrer" className="tool-btn" title="Aspire — traces & logs">Logs</a>
            <a href="http://localhost:9000"  target="_blank" rel="noreferrer" className="tool-btn" title="Portainer — container management">Portainer</a>
            <button
              className={`tool-btn ${activeView === 'settings' ? 'tool-btn-active' : ''}`}
              onClick={() => onViewChange('settings')}
              title="Settings"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '3px 8px' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.69.07-1.08s-.03-.74-.07-1.08l2.33-1.82c.21-.17.27-.46.14-.7l-2.2-3.82c-.14-.24-.42-.32-.66-.24l-2.74 1.1c-.57-.44-1.18-.8-1.84-1.08l-.42-2.9c-.04-.26-.27-.46-.54-.46H9.5c-.27 0-.5.2-.54.46l-.42 2.9c-.66.28-1.27.64-1.84 1.08l-2.74-1.1c-.24-.08-.52 0-.66.24l-2.2 3.82c-.14.24-.07.53.14.7L3.57 10c-.04.34-.07.69-.07 1.08s.03.74.07 1.08L1.24 13.98c-.21.17-.27.46-.14.7l2.2 3.82c.14.24.42.32.66.24l2.74-1.1c.57.44 1.18.8 1.84 1.08l.42 2.9c.04.26.27.46.54.46h4.4c.27 0 .5-.2.54-.46l.42-2.9c.66-.28 1.27-.64 1.84-1.08l2.74 1.1c.24.08.52 0 .66-.24l2.2-3.82c.14-.24.07-.53-.14-.7l-2.33-1.9z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Row 2: status bar ──────────────────────────────────────────────── */}
      <div className="header-statusbar">
        {!health && (
          <span className="live-chip live-chip-connecting">connecting…</span>
        )}
        {health && (
          <span
            className={`live-chip live-chip-api ${ok ? 'live-chip-api-ok' : 'live-chip-api-err'}`}
            title={ok ? 'Backend API is healthy' : 'Backend API error'}
          >
            {ok ? '✅' : '🔴'} API
          </span>
        )}
        {health && (
          <span
            className={`live-chip ${open ? 'live-chip-market-open' : 'live-chip-market-closed'}`}
            title={open
              ? (closeIn ? `Closes in ${closeIn}` : 'US equity market is currently open')
              : (openIn  ? `Opens in ${openIn}`   : 'US equity market is currently closed')}
          >
            {open ? '🟢' : '🔴'} US Market {open ? 'Open' : 'Closed'}
            {open  && closeIn && <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 5 }}>· closes in {closeIn}</span>}
            {!open && openIn  && <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 5 }}>· opens in {openIn}</span>}
          </span>
        )}
        {health && modelLabel && (
          <span className="live-chip live-chip-model" title={`Active LLM: ${modelLabel}`}>
            🧠 {modelLabel}
          </span>
        )}
        {health && usage && (
          <span
            className="live-chip live-chip-tokens"
            title={[
              `Tokens today (${activeModel ? activeModel.split('/').pop() : 'all models'}): ${todayTokens.toLocaleString()}`,
              `  analysis: ${fmtTokens(modelTodayTokens)}  backtests: ${fmtTokens(btTodayTokens)}`,
              `All providers today: ${fmtTokens(todayEntry?.total_tokens ?? 0)}`,
              `All-time (${usage?.period_days ?? 30}d): ${fmtTokens(usage?.total_prompt_tokens ?? 0)} prompt + ${fmtTokens(usage?.total_completion_tokens ?? 0)} completion`,
            ].join('\n')}
          >
            ⚡ {fmtTokens(todayTokens)} tok tod
          </span>
        )}

        {/* ── Scheduler chip ───────────────────────────────────────── */}
        {health && (() => {
          const sched      = health.scheduler ?? {}
          const running    = sched.running ?? false
          const lastRun    = sched.last_run   ? new Date(sched.last_run).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
          const nextRun    = sched.next_run   ? new Date(sched.next_run).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
          const interval   = sched.scan_interval_minutes ?? null
          const title      = [
            running ? 'Scanner active' : 'Scanner stopped',
            interval ? `Interval: ${interval} min` : null,
            lastRun  ? `Last scan: ${lastRun}` : null,
            nextRun  ? `Next scan: ${nextRun}` : null,
          ].filter(Boolean).join('\n')
          return (
            <span className={`live-chip ${running ? 'live-chip-market-open' : 'live-chip-market-closed'}`} title={title}>
              🤖 Scanner: {running ? 'Active' : 'Off'}
              {running && lastRun && <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 5 }}>· last {lastRun}</span>}
              {running && nextRun && <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 5 }}>· next {nextRun}</span>}
            </span>
          )
        })()}

        {/* ── Watchlist count chip ─────────────────────────────────── */}
        {health && (
          <span className="live-chip live-chip-model"
                title={`Watchlist: ${health.watchlist_size ?? 0} ticker(s) being monitored`}>
            📋 {health.watchlist_size ?? 0} tickers
          </span>
        )}

        {/* ── Last discovery chip ──────────────────────────────────── */}
        {health && (() => {
          const sched       = health.scheduler ?? {}
          const lastDisc    = sched.last_discovery ? new Date(sched.last_discovery).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
          const nextDisc    = sched.next_discovery ? new Date(sched.next_discovery).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
          const title       = [
            lastDisc ? `Last discovery: ${lastDisc}` : 'No discovery run yet',
            nextDisc ? `Next discovery: ${nextDisc}` : null,
          ].filter(Boolean).join('\n')
          return (
            <span className="live-chip live-chip-tokens" title={title}>
              🔥 Discovery: {lastDisc ?? 'not run'}
              {nextDisc && <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 5 }}>· next {nextDisc}</span>}
            </span>
          )
        })()}

      </div>

    </header>
  )
}
