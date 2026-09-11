import { useState, useEffect } from 'react'
import { usePolling } from './hooks/usePolling'
import Header from './components/shared/Header'
import WatchlistCard from './components/shared/WatchlistCard'
import PaperOrdersPanel from './components/shared/PaperOrdersPanel'
import LoginScreen from './components/shared/LoginScreen'
import SignalsTable from './components/signals/SignalsTable'
import ExplorerPage from './pages/ExplorerPage'
import EducationPage from './pages/EducationPage'
import SettingsPage from './pages/SettingsPage'
import TrendingPage from './pages/TrendingPage'
import PaperTradingPage from './pages/PaperTradingPage'
import BacktestPage from './pages/BacktestPage'

export default function App() {
  const [authed, setAuthed] = useState(() => !!sessionStorage.getItem('admin_token'))

  // Re-login when the backend rejects our token (e.g. after ADMIN_TOKEN rotation).
  // signal401() fires 'auth-expired' from usePolling / readSSEStream on any HTTP 401.
  useEffect(() => {
    const handler = () => setAuthed(false)
    window.addEventListener('auth-expired', handler)
    return () => window.removeEventListener('auth-expired', handler)
  }, [])

  const { data: health, reload: reloadHealth }  = usePolling('/health', 30_000)
  const { data: wl, reload: reloadWatchlist }   = usePolling('/watchlist', 60_000)
  const { data: signals, reload: reloadSignals } = usePolling('/signals?limit=30', 60_000)
  // Token usage — 30-day window; drives header chip + settings section
  const { data: usage, reload: reloadUsage }    = usePolling('/usage', 60_000)
  // Market clock — drives the header "US Market Open/Closed · closes in Xm" pill
  const { data: paperClock }                    = usePolling('/paper/clock', 60_000)
  // Paper orders — used to show existing order status on signal cards
  const { data: dashPaperOrders }               = usePolling('/paper/orders?limit=200', 60_000)
  // Backtest runs list — used to include LLM backtest tokens in the header chip
  const { data: btListData }                    = usePolling('/backtest', 60_000)
  const btTodayTokens = (() => {
    const todayIso     = new Date().toISOString().slice(0, 10)
    const activeModel  = usage?.active_model    ?? null
    const activeProv   = usage?.active_provider ?? null
    return (btListData?.runs ?? [])
      .filter(r =>
        (r.created_at ?? '').slice(0, 10) === todayIso &&
        // filter to active model when we have provider info; otherwise sum all
        (!activeProv || (r.llm_provider ?? null) === activeProv) &&
        (!activeModel || (r.llm_model   ?? null) === activeModel)
      )
      .reduce((s, r) => s + (r.llm_prompt_tokens ?? 0) + (r.llm_completion_tokens ?? 0), 0)
  })()

  const [activeView, setActiveView] = useState('dashboard')
  const [explorerState, setExplorerState] = useState(null)
  // When a sidebar order row is clicked, navigate to Trading and pre-expand that order
  const [tradingExpandOrder, setTradingExpandOrder] = useState(null)
  // When another page deep-links into Settings, store the target section id here
  const [settingsAnchor, setSettingsAnchor] = useState(null)

  const openSettings = (sectionId) => {
    setSettingsAnchor(sectionId)
    setActiveView('settings')
  }
  // Increment to force-remount ExplorerPage only when a new result arrives from Dashboard.
  // Tab switching leaves explorerKey unchanged so the running SSE stream is preserved.
  const [explorerKey, setExplorerKey] = useState(0)

  // Paper orders panel — open state persisted to localStorage
  const [paperPanelOpen, setPaperPanelOpen] = useState(() => {
    try { return localStorage.getItem('paper_panel_open') !== 'false' }
    catch { return true }
  })
  const togglePaperPanel = () => {
    setPaperPanelOpen(v => {
      const next = !v
      try { localStorage.setItem('paper_panel_open', String(next)) } catch {}
      return next
    })
  }

  const openExplorer = (result) => {
    setExplorerState(result)
    setExplorerKey(k => k + 1)   // reset Explorer state for the new result
    setActiveView('explorer')
  }

  // Auth gate — must come after all hooks so hook call order is stable.
  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />

  return (
    <div className="app">
      <Header health={health} usage={usage} btTodayTokens={btTodayTokens} activeView={activeView} onViewChange={setActiveView} clock={paperClock} />
      <main className="main">
        {/* All three views are always mounted — switching tabs never destroys SSE state */}
        <div style={{ display: activeView === 'dashboard' ? 'flex' : 'none',
                      flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <PaperOrdersPanel
            open={paperPanelOpen}
            onToggle={togglePaperPanel}
            onOrderClick={(orderId) => {
              setTradingExpandOrder(orderId)
              setActiveView('paper')
            }}
          />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Dashboard info bar */}
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center',
              padding: '7px 14px', borderRadius: 8,
              background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
              fontSize: 12, color: 'var(--dim)',
            }}>
              <span>📊 <strong>Live prices</strong> refresh every 30 s via Alpaca</span>
              <span style={{ color: 'color-mix(in srgb, var(--dim) 40%, transparent)' }}>·</span>
              {(() => {
                const scanMin = wl?.scheduler?.scan_interval_minutes ?? wl?.scan_interval_minutes ?? 15
                // Derive next-run from last_run + current interval (avoids stale value
                // during the current sleep cycle when the interval was just changed).
                const lastRunIso = wl?.scheduler?.last_run
                const nextRunDerived = lastRunIso
                  ? new Date(new Date(lastRunIso).getTime() + scanMin * 60_000)
                  : (wl?.scheduler?.next_run ? new Date(wl.scheduler.next_run) : null)
                return (
                  <>
                    <span>🤖 <strong>AI signal scan</strong> runs every {scanMin} min during market hours</span>
                    {(lastRunIso || nextRunDerived) && (
                      <span style={{ width: '100%', height: 0, display: 'block', margin: 0, padding: 0 }} />
                    )}
                    {lastRunIso && (
                      <span title={lastRunIso}>
                        🕐 Last scan: {new Date(lastRunIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {lastRunIso && nextRunDerived && (
                      <span style={{ color: 'color-mix(in srgb, var(--dim) 40%, transparent)' }}>·</span>
                    )}
                    {nextRunDerived && (
                      <span title={nextRunDerived.toISOString()}>
                        ⏭ Next scan: {nextRunDerived.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </>
                )
              })()}
            </div>
            <WatchlistCard wl={wl} onWatchlistChange={reloadWatchlist} signals={signals} />
            <SignalsTable
              signals={signals}
              reload={reloadSignals}
              signalOrderMap={Object.fromEntries(
                (dashPaperOrders?.orders ?? [])
                  .filter(o => o.signal_id != null)
                  .map(o => [o.signal_id, o])
              )}
            />
          </div>
        </div>
        <div style={{ display: activeView === 'explorer' ? '' : 'none' }}>
          <ExplorerPage
            key={explorerKey}
            initialResult={explorerState}
            onBack={() => setActiveView('dashboard')}
            modelName={health?.llm_model ?? health?.ollama_model}
            onOpenInExplorer={openExplorer}
          />
        </div>
        {/* Education and Backtest are light enough to mount on demand */}
        {activeView === 'education' && <EducationPage />}
        {activeView === 'backtest' && <BacktestPage wl={wl} usage={usage} />}

        {/* Trending/Discovery and Trading are always mounted so state (run results,
            positions, etc.) survives tab switches — only visibility is toggled. */}
        <div style={{ display: activeView === 'trending' ? '' : 'none' }}>
          <TrendingPage onViewChange={setActiveView} onOpenSettings={openSettings} onOpenExplorer={openExplorer} />
        </div>
        <div style={{ display: activeView === 'paper' ? '' : 'none' }}>
          <PaperTradingPage
            initialExpandedOrder={tradingExpandOrder}
            onExpandedOrderConsumed={() => setTradingExpandOrder(null)}
          />
        </div>
        {activeView === 'settings' && (
          <SettingsPage
            usage={usage}
            onUsageRefresh={reloadUsage}
            onHealthRefresh={reloadHealth}
            initialSection={settingsAnchor}
            onInitialSectionConsumed={() => setSettingsAnchor(null)}
          />
        )}
      </main>
      <footer className="footer">
        <span className="footer-brand">MarketSage</span>
        {health && (
          <>
            <span className="footer-sep">·</span>
            <span>v{health.version}</span>
            <span className="footer-sep">·</span>
            <span>{health.ollama_model}</span>
          </>
        )}
        <span className="footer-sep">·</span>
        <span>Built {new Date(__BUILD_TIME__).toLocaleString()}</span>
        <span className="footer-sep">·</span>
        <span className="footer-disclaimer">Not financial advice</span>
      </footer>
    </div>
  )
}
