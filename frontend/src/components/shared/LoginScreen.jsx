import { useState, useEffect, useRef } from 'react'
import { API } from '../../utils/api'

const LOGIN_TICKER_TAPE = ['SPY +0.34%','AAPL +1.2%','NVDA -0.8%','TSLA +2.1%','BTC +3.4%','MSFT +0.6%','ACN +1.7%','AMZN -0.3%','META +1.8%','EUROB +4.2%','GOOG +0.9%','GLD -0.2%','QQQ +0.7%','JPM +0.4%']
const LOGIN_LOGS = [
  '> Connecting to market data feed…',
  '> Authenticated with Alpaca Paper API ✓',
  '> Loading LLM inference engine…',
  '> Multi-timeframe RSI engine ready ✓',
  '> Macro regime filter online ✓',
  '> Opportunity scanner armed ✓',
  '> All systems nominal. Awaiting operator clearance.',
]

export default function LoginScreen({ onLogin }) {
  const [input, setInput]     = useState('')
  const [err, setErr]         = useState('')
  const [loading, setLoading] = useState(false)
  const [devMode, setDevMode] = useState(null)
  const [logLines, setLogLines] = useState([])
  const [shake, setShake]       = useState(false)
  const [waking, setWaking]     = useState(false)  // true while cold-start retry is in-flight
  const inputRef = useRef(null)

  // Boot log animation
  useEffect(() => {
    let i = 0
    const t = setInterval(() => {
      setLogLines(prev => [...prev, LOGIN_LOGS[i]])
      i++
      if (i >= LOGIN_LOGS.length) clearInterval(t)
    }, 420)
    return () => clearInterval(t)
  }, [])

  // Dev mode probe
  useEffect(() => {
    fetch(`${API}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: '' }) })
      .then(r => r.json()).then(d => { if (d.dev_mode) setDevMode(true) }).catch(() => {})
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true); setErr(''); setWaking(false)

    const doFetch = () => fetch(`${API}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: input }),
    })

    try {
      let r
      try {
        r = await doFetch()
      } catch {
        // Network error — Fly.io machine may be cold-starting.
        // Wait 4 s and retry once before giving up.
        setWaking(true)
        await new Promise(res => setTimeout(res, 4000))
        setWaking(false)
        r = await doFetch()   // throws again → outer catch shows OFFLINE
      }
      if (r.ok) {
        sessionStorage.setItem('admin_token', input)
        onLogin()
      } else {
        setErr('ACCESS DENIED — invalid credentials')
        setShake(true)
        setTimeout(() => setShake(false), 600)
        inputRef.current?.select()
      }
    } catch {
      setErr('OFFLINE — backend unreachable')
    } finally {
      setLoading(false); setWaking(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: '#0a0f0a', overflow: 'hidden', zIndex: 9999 }}>

      {/* ══ Full-width ticker tape ══ */}
      <div style={{ overflow: 'hidden', background: '#001a00', borderBottom: '1px solid #00ff4125', padding: '6px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 40, whiteSpace: 'nowrap', animation: 'loginTicker 22s linear infinite', fontFamily: '"Courier New", monospace', fontSize: 11, color: '#00ff41', letterSpacing: '0.5px' }}>
          {[...LOGIN_TICKER_TAPE, ...LOGIN_TICKER_TAPE].map((t, i) => (
            <span key={i} style={{ color: t.includes('-') ? '#ff4444' : '#00ff41' }}>{t}</span>
          ))}
        </div>
      </div>

      {/* ══ Panels row ══ */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* ══ LEFT — hacker branding ══ */}
      <div style={{ width: 420, flexShrink: 0, background: '#0a0f0a', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', borderRight: '1px solid #00ff4120' }}>

        {/* CRT scanline overlay */}
        <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.18) 2px, rgba(0,0,0,.18) 4px)', zIndex: 10 }} />

        {/* Body */}
        <div style={{ flex: 1, padding: '28px 36px', display: 'flex', flexDirection: 'column', gap: 20, position: 'relative', zIndex: 1 }}>

          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, border: '1px solid #00cc33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: '0 0 8px #00ff4130' }}>📈</div>
            <span style={{ fontFamily: '"Courier New", monospace', fontSize: 14, color: '#00ff41', textShadow: '0 0 10px #00ff4180', letterSpacing: 3, textTransform: 'uppercase' }}>OffGrid&nbsp;Trader</span>
          </div>

          {/* Tagline */}
          <div style={{ fontFamily: '"Courier New", monospace', color: '#00cc33', fontSize: 22, fontWeight: 'bold', lineHeight: 1.3, textShadow: '0 0 15px #00ff4140' }}>
            Algorithmic signals,<br /><span style={{ color: '#38bdf8', textShadow: '0 0 10px #38bdf850' }}>institutional edge.</span>
          </div>

          <div style={{ fontFamily: '"Courier New", monospace', fontSize: 12, color: '#4a8f5a', lineHeight: 1.7, maxWidth: 380 }}>
            Multi-timeframe RSI · macro regime filtering<br />
            LLM-powered analysis · Alpaca paper execution<br />
            Running 24/7. Waiting for your clearance.
          </div>

          {/* Boot log box */}
          <div style={{ border: '1px solid #00ff4115', background: '#020a02', padding: '14px 16px', borderRadius: 2, display: 'flex', flexDirection: 'column', gap: 4, minHeight: 140 }}>
            {logLines.map((l, i) => (
              <div key={i} style={{ fontFamily: '"Courier New", monospace', fontSize: 11, color: l?.startsWith('> All') || l?.includes('✓') ? '#00cc33' : l?.includes('armed') ? '#ffcc00' : '#4a8f5a', opacity: i === logLines.length - 1 ? 1 : 0.8, whiteSpace: 'nowrap' }}>{l}</div>
            ))}
            {logLines.length < LOGIN_LOGS.length && (
              <span style={{ fontFamily: '"Courier New", monospace', fontSize: 11, color: '#00ff41', animation: 'loginBlink 1s step-end infinite' }}>█</span>
            )}
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 24, marginTop: 'auto', paddingTop: 16, borderTop: '1px solid #00ff4115' }}>
            {[['15m','Scan int.'],['3×','Timeframes'],['LLM','AI-backed']].map(([v,l]) => (
              <div key={l}>
                <div style={{ fontFamily: '"Courier New", monospace', fontSize: 20, color: '#00ff41', textShadow: '0 0 8px #00ff4160' }}>{v}</div>
                <div style={{ fontFamily: '"Courier New", monospace', fontSize: 10, color: '#3a5a3a', textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Status bar */}
        <div style={{ fontFamily: '"Courier New", monospace', fontSize: 10, color: '#2a4a2a', background: '#010501', padding: '5px 36px', borderTop: '1px solid #00ff4112', letterSpacing: '0.5px', flexShrink: 0, zIndex: 1 }}>
          SYS: <span style={{ color: '#00cc33' }}>NOMINAL</span> &nbsp;|&nbsp; DB: <span style={{ color: '#00cc33' }}>CONNECTED</span> &nbsp;|&nbsp; STREAM: <span style={{ color: '#00cc33' }}>LIVE</span> &nbsp;|&nbsp; v2.3.0
        </div>
      </div>

      {/* ══ RIGHT — hacker form panel ══ */}
      <div style={{ flex: 1, background: '#050a05', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '48px 44px', position: 'relative', borderLeft: '1px solid #00ff4115' }}>

        {/* scanlines on right too */}
        <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.18) 2px, rgba(0,0,0,.18) 4px)' }} />

        <div style={{ width: '100%', maxWidth: 400, position: 'relative', zIndex: 1 }}>

          {/* Terminal title bar */}
          <div style={{ background: '#001a00', border: '1px solid #00ff4130', borderBottom: 'none', borderRadius: '4px 4px 0 0', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#febc2e', display: 'inline-block' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840', display: 'inline-block' }} />
            <span style={{ marginLeft: 8, fontSize: 10, color: '#00ff4160', letterSpacing: 2, fontFamily: '"Courier New", monospace' }}>SECURE TERMINAL — AUTH</span>
          </div>

          {/* Card body */}
          <div style={{ border: '1px solid #00ff4130', borderRadius: '0 0 4px 4px', background: '#020a02', boxShadow: '0 0 30px #00ff4115, 0 0 60px #00ff4108', animation: shake ? 'loginShake 0.5s' : undefined }}>

            {/* Operator header */}
            <div style={{ padding: '18px 20px 0', fontFamily: '"Courier New", monospace' }}>
              <div style={{ fontSize: 10, color: '#00ff4160', letterSpacing: 2, marginBottom: 4 }}>
                {devMode ? '// DEV MODE — no credentials required' : '// OPERATOR CLEARANCE REQUIRED'}
              </div>
              <div style={{ fontSize: 18, color: '#00ff41', textShadow: '0 0 10px #00ff4160', marginBottom: 2 }}>Access Terminal</div>
              <div style={{ fontSize: 11, color: '#3a6a3a', marginBottom: 16 }}>Enter your admin token to authenticate.</div>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} style={{ padding: '0 20px 20px', fontFamily: '"Courier New", monospace' }}>

              <div style={{ fontSize: 10, color: '#3a6a3a', letterSpacing: 1, marginBottom: 6 }}>ACCESS_TOKEN</div>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ color: '#00ff41', fontSize: 14, padding: '9px 10px', background: '#001a00', border: '1px solid #00ff4140', borderRight: 'none', borderRadius: '3px 0 0 3px', flexShrink: 0 }}>$</span>
                <input
                  ref={inputRef}
                  type="password"
                  value={input}
                  onChange={e => { setInput(e.target.value); setErr('') }}
                  placeholder={devMode ? 'press ENTER to continue' : 'enter access token…'}
                  autoFocus
                  autoComplete="current-password"
                  style={{
                    flex: 1, padding: '9px 12px',
                    background: '#001a00', color: '#00ff41',
                    border: '1px solid #00ff4140', borderRight: 'none',
                    outline: 'none', fontSize: 13,
                    fontFamily: 'inherit', letterSpacing: 2,
                  }}
                />
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    padding: '9px 16px', background: loading ? '#001a00' : '#00ff4115',
                    color: '#00ff41', border: '1px solid #00ff4140',
                    borderRadius: '0 3px 3px 0', cursor: loading ? 'not-allowed' : 'pointer',
                    fontSize: 12, fontFamily: 'inherit', letterSpacing: 2,
                    transition: 'background 0.2s', flexShrink: 0,
                  }}
                >{loading ? '…' : 'AUTH'}</button>
              </div>

              {waking && (
                <div style={{ fontSize: 11, color: '#f59e0b', letterSpacing: 1, marginBottom: 10 }}>
                  ⏳ Waking up backend… retrying
                </div>
              )}
              {err && !waking && (
                <div style={{ fontSize: 11, color: '#ff4444', letterSpacing: 1, marginBottom: 10, animation: 'loginBlink 0.3s 2' }}>
                  ⚠ {err}
                </div>
              )}

              <div style={{ borderTop: '1px solid #00ff4112', paddingTop: 14, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#2a4a2a', letterSpacing: 0.5 }}>
                <span>SYS:NOMINAL&nbsp;|&nbsp;DB:OK</span>
                <span>UNAUTHORIZED ACCESS PROSECUTED</span>
              </div>
            </form>
          </div>
        </div>
      </div>

      </div>{/* /panels row */}

      <style>{`
        @keyframes loginBlink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes loginTicker { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        @keyframes loginShake {
          0%,100%{transform:translateX(0)}
          20%{transform:translateX(-8px)} 40%{transform:translateX(8px)}
          60%{transform:translateX(-5px)} 80%{transform:translateX(5px)}
        }
      `}</style>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

