import { useState, useEffect } from 'react'
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  AreaChart, Area,
} from 'recharts'
import { API, getAuthHeaders } from '../utils/api'
import { fmtTokens } from '../utils/fmt'
import { AXIS_TICK } from '../utils/colors'

const USAGE_PERIODS = [
  { label: 'Today',  days: 1  },
  { label: '3 days', days: 3  },
  { label: '7 days', days: 7  },
  { label: '30 days',days: 30 },
  { label: '90 days',days: 90 },
]

export default function UsageSection({ usage: usageProp, onRefresh }) {
  const [selModel,    setSelModel]    = useState(null)   // null = "All"
  const [quota,       setQuota]       = useState(null)
  const [quotaErr,    setQuotaErr]    = useState(null)
  const [periodDays,  setPeriodDays]  = useState(30)
  const [localUsage,  setLocalUsage]  = useState(null)
  const [localLoading,setLocalLoading]= useState(false)

  // Fetch usage for the selected period whenever it changes.
  const fetchLocalUsage = (days) => {
    setLocalLoading(true)
    fetch(`${API}/usage?days=${days}`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setLocalUsage(d); setLocalLoading(false) })
      .catch(() => setLocalLoading(false))
  }
  useEffect(() => { fetchLocalUsage(periodDays) }, [periodDays])  // eslint-disable-line react-hooks/exhaustive-deps

  // The displayed data: local (period-specific) if loaded, otherwise the root prop.
  const usage = localUsage ?? usageProp

  // Auto-select the active provider+model when usage first loads.
  const activeKey = usage?.active_provider && usage?.active_model
    ? `${usage.active_provider}::${usage.active_model}`
    : null
  useEffect(() => {
    if (activeKey && selModel === null) setSelModel(activeKey)
  }, [activeKey])  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch quota once on mount so limits are visible without a button click.
  useEffect(() => {
    fetch(`${API}/provider/quota`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(setQuota)
      .catch(e => setQuotaErr(e.message))
  }, [])

  if (!usage) return (
    <p className="text-dim" style={{ fontSize: 13 }}>Loading usage data…</p>
  )

  const { period_days, by_provider = [], by_day = [], by_model_day = [], by_source = [] } = usage

  // Build the list of selectable model keys: "provider::model"
  const modelKeys = by_provider.map(p => `${p.provider}::${p.model}`)

  // Stats for the selected model (or overall totals)
  const selStats = selModel
    ? by_provider.find(p => `${p.provider}::${p.model}` === selModel) ?? {}
    : {
        total_tokens:      usage.total_tokens      ?? 0,
        prompt_tokens:     usage.total_prompt_tokens  ?? 0,
        completion_tokens: usage.total_completion_tokens ?? 0,
        rows:              usage.total_rows         ?? 0,
      }

  // Daily chart data — filter by selected model or use all-provider by_day.
  // Normalise to { date, prompt_tokens, completion_tokens, total_tokens } for the chart.
  const chartData = (() => {
    if (!selModel) return [...by_day].reverse()   // oldest → newest; already has `date` key
    const [sp, sm] = selModel.split('::')
    const filtered = by_model_day
      .filter(r => r.provider === sp && r.model === sm)
      .map(r => ({ ...r, date: r.day ?? r.date }))  // normalise day→date for XAxis
    return [...filtered].reverse()
  })()

  // Quota limits for the selected provider (or active provider)
  const selProvider  = selModel ? selModel.split('::')[0] : quota?.provider
  const selModelName = selModel ? selModel.split('::')[1] : null

  // Groq live rate-limit headers
  const groqLimits = quota?.rate_limits
  // Static free-tier limits (Gemini, Mistral)
  const freeLimits = quota?.free_tier_limits
  // Dashboard URL
  const dashUrl = quota?.dashboard_url

  // ── Per-provider cost tables (rough public pricing, USD per 1M tokens) ──────
  // Groq free tier = $0; paid tier shown as reference for estimation purposes.
  const COST_PER_1M = {
    groq:    { input: 0.05,  output: 0.08,  note: 'Groq paid (varies by model)' },
    gemini:  { input: 0.075, output: 0.30,  note: 'Gemini Flash free tier = $0; paid ~$0.075/$0.30' },
    mistral: { input: 0.10,  output: 0.30,  note: 'Mistral free tier; paid varies' },
    ollama:  { input: 0,     output: 0,     note: 'Local model — no cost' },
  }
  const costMeta   = COST_PER_1M[(selProvider ?? '').toLowerCase()] ?? null
  const estCostUSD = costMeta
    ? ((selStats.prompt_tokens ?? 0) * costMeta.input +
       (selStats.completion_tokens ?? 0) * costMeta.output) / 1_000_000
    : null

  // ── TPM utilisation (uses the active quota limits from /provider/quota) ──────
  // Best-available limit: live Groq header → free-tier table → null
  const activeLim = (() => {
    if (groqLimits?.tokens_limit) return { tpm: null, note: `${groqLimits.tokens_remaining} / ${groqLimits.tokens_limit} tokens remaining (period reset: ${groqLimits.tokens_reset ?? '?'})` }
    if (freeLimits) {
      // Prefer exact match; fall back to the most-restrictive entry so the gauge is safe.
      const exact = selModelName ? freeLimits[selModelName] : null
      const l = exact ?? Object.values(freeLimits).sort((a, b) => (a.tpm ?? 0) - (b.tpm ?? 0))[0]
      if (l) return { tpm: l.tpm, rpm: l.rpm, rpd: l.rpd }
    }
    return null
  })()
  // Average daily calls (from by_day rows count)
  const avgDailyCalls  = chartData.length
    ? chartData.reduce((s, d) => s + (d.rows ?? 0), 0) / chartData.length
    : 0
  const avgDailyTokens = chartData.length
    ? chartData.reduce((s, d) => s + (d.prompt_tokens ?? 0) + (d.completion_tokens ?? 0), 0) / chartData.length
    : 0

  return (
    <div>
      {/* ── Period selector ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="text-dim" style={{ fontSize: 12, marginRight: 4 }}>Period:</span>
        {USAGE_PERIODS.map(({ label, days }) => (
          <button
            key={days}
            className={`filter-btn${periodDays === days ? ' active' : ''}`}
            onClick={() => setPeriodDays(days)}
            style={{ fontSize: 12, padding: '3px 10px' }}
          >
            {label}
          </button>
        ))}
        {localLoading && <span className="text-dim" style={{ fontSize: 11, marginLeft: 4 }}>↻</span>}
      </div>

      {/* ── Model selector chips ──────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {/* "All" chip */}
        <button
          className={`live-chip live-chip-model ${!selModel ? 'active' : ''}`}
          style={{
            cursor: 'pointer', border: !selModel ? '1px solid var(--purple)' : undefined,
            opacity: 1, background: !selModel ? 'rgba(139,92,246,0.15)' : undefined,
          }}
          onClick={() => setSelModel(null)}
        >
          All models
        </button>
        {modelKeys.map(key => {
          const p = by_provider.find(p => `${p.provider}::${p.model}` === key)
          const active = selModel === key
          return (
            <button key={key}
              className="live-chip live-chip-model"
              style={{
                cursor: 'pointer',
                border: active ? '1px solid var(--purple)' : undefined,
                background: active ? 'rgba(139,92,246,0.15)' : undefined,
                opacity: 1,
              }}
              onClick={() => setSelModel(active ? null : key)}
            >
              {key.replace('::', ' · ')}
              <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--dim)' }}>
                {fmtTokens(p?.total_tokens ?? 0)}
              </span>
            </button>
          )
        })}
        <button className="btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
          onClick={() => { onRefresh(); fetchLocalUsage(periodDays) }}>
          ↺ Refresh
        </button>
      </div>

      {/* ── Summary stat cards ────────────────────────────────────────── */}
      <div className="usage-summary-row" style={{ marginBottom: 16 }}>
        <div className="usage-stat-card">
          <span className="usage-stat-label">Total tokens</span>
          <span className="usage-stat-value">{fmtTokens(selStats.total_tokens ?? 0)}</span>
          <span className="usage-stat-sub">last {period_days}d</span>
        </div>
        <div className="usage-stat-card">
          <span className="usage-stat-label">Prompt</span>
          <span className="usage-stat-value">{fmtTokens(selStats.prompt_tokens ?? 0)}</span>
          <span className="usage-stat-sub">input</span>
        </div>
        <div className="usage-stat-card">
          <span className="usage-stat-label">Completion</span>
          <span className="usage-stat-value">{fmtTokens(selStats.completion_tokens ?? 0)}</span>
          <span className="usage-stat-sub">output</span>
        </div>
        <div className="usage-stat-card">
          <span className="usage-stat-label">LLM calls</span>
          <span className="usage-stat-value">{(selStats.rows ?? 0).toLocaleString()}</span>
          <span className="usage-stat-sub">last {period_days}d · ~{Math.round(avgDailyCalls)}/day</span>
        </div>
        {estCostUSD !== null && (
          <div className="usage-stat-card" style={{ borderColor: 'rgba(251,191,36,0.3)' }}>
            <span className="usage-stat-label">Est. cost</span>
            <span className="usage-stat-value" style={{ color: estCostUSD < 0.001 ? 'var(--green)' : 'var(--yellow)' }}>
              {estCostUSD < 0.001 ? '$0' : `$${estCostUSD.toFixed(4)}`}
            </span>
            <span className="usage-stat-sub">{costMeta.note}</span>
          </div>
        )}
      </div>

      {/* ── By-source breakdown ──────────────────────────────────────── */}
      {/* "Signals / Explorer" = AI analysis runs from Dashboard/Explorer scans */}
      {/* "Backtesting" = LLM-mode backtest runs */}
      {by_source.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          {by_source.map(s => (
            <div key={s.source} className="usage-stat-card" style={{ flex: '1 1 140px' }}>
              <span className="usage-stat-label">{s.label}</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>
                {fmtTokens(s.total_tokens)}
              </span>
              <span className="usage-stat-sub">
                {s.rows} call{s.rows !== 1 ? 's' : ''} · {fmtTokens(s.prompt_tokens)} in / {fmtTokens(s.completion_tokens)} out
              </span>
            </div>
          ))}
          {!by_source.find(s => s.source === 'signal') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">Signals / Explorer</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no AI scans yet this period</span>
            </div>
          )}
          {!by_source.find(s => s.source === 'backtest_review') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">AI Review</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no reviews yet this period</span>
            </div>
          )}
          {!by_source.find(s => s.source === 'backtest_experiment_advisor') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">Experiment Advisor</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no suggestions yet this period</span>
            </div>
          )}
          {!by_source.find(s => s.source === 'backtest_compare') && (
            <div className="usage-stat-card" style={{ flex: '1 1 140px', opacity: 0.45 }}>
              <span className="usage-stat-label">Run Compare</span>
              <span className="usage-stat-value" style={{ fontSize: 15 }}>0</span>
              <span className="usage-stat-sub">no comparisons yet this period</span>
            </div>
          )}
        </div>
      )}

      {/* ── Daily usage chart ─────────────────────────────────────────── */}
      {chartData.length > 0 ? (
        <div style={{ marginBottom: 20 }}>
          <div className="settings-label" style={{ marginBottom: 8 }}>
            Daily token usage{selModel ? ` — ${selModel.replace('::', ' · ')}` : ' — all models'}
          </div>
          <ResponsiveContainer width="100%" height={160}>
            {chartData.length < 3 ? (
              /* BarChart for sparse data (1–2 days) — AreaChart needs ≥3 points to draw a line */
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={v => v?.slice(5)} />
                <YAxis tick={AXIS_TICK} tickFormatter={v => fmtTokens(v)} width={52} />
                <Tooltip
                  {...CHART_TOOLTIP_STYLE}
                  formatter={(v, name) => [v.toLocaleString(), name === 'prompt_tokens' ? 'Prompt' : 'Completion']}
                  labelFormatter={l => `Date: ${l}`}
                />
                <Bar dataKey="prompt_tokens"     fill="#a855f7" name="prompt_tokens"     stackId="a" />
                <Bar dataKey="completion_tokens" fill="#818cf8" name="completion_tokens" stackId="a" radius={[3,3,0,0]} />
              </BarChart>
            ) : (
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="usageGradPrompt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#a855f7" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="usageGradCompl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#818cf8" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#818cf8" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={v => v?.slice(5)} />
                <YAxis tick={AXIS_TICK} tickFormatter={v => fmtTokens(v)} width={52} />
                <Tooltip
                  {...CHART_TOOLTIP_STYLE}
                  formatter={(v, name) => [v.toLocaleString(), name === 'prompt_tokens' ? 'Prompt' : name === 'completion_tokens' ? 'Completion' : 'Total']}
                  labelFormatter={l => `Date: ${l}`}
                />
                <Area type="monotone" dataKey="prompt_tokens"
                      stroke="#a855f7" strokeWidth={2} fill="url(#usageGradPrompt)"
                      dot={{ r: 3, fill: '#a855f7' }} name="prompt_tokens" />
                <Area type="monotone" dataKey="completion_tokens"
                      stroke="#818cf8" strokeWidth={1.5} fill="url(#usageGradCompl)"
                      dot={{ r: 2, fill: '#818cf8' }} name="completion_tokens" />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-dim" style={{ fontSize: 12, marginBottom: 16 }}>
          No usage data for this period.{' '}
          {selModel && <span>Try selecting <strong>All models</strong>.</span>}
        </p>
      )}

      {/* ── Daily LLM calls chart ─────────────────────────────────────── */}
      {chartData.length > 0 && chartData.some(d => (d.rows ?? 0) > 0) && (
        <div style={{ marginBottom: 20 }}>
          <div className="settings-label" style={{ marginBottom: 8 }}>
            LLM calls per day{selModel ? ` — ${selModel.replace('::', ' · ')}` : ' — all models'}
          </div>
          <ResponsiveContainer width="100%" height={110}>
            <BarChart data={[...chartData]} margin={{ top: 2, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={v => v?.slice(5)} />
              <YAxis tick={AXIS_TICK} allowDecimals={false} width={32} />
              <Tooltip
                {...CHART_TOOLTIP_STYLE}
                formatter={(v) => [v, 'Calls']}
                labelFormatter={l => `Date: ${l}`}
              />
              <Bar dataKey="rows" fill="#34d399" radius={[3, 3, 0, 0]} name="Calls" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── TPM / quota utilisation bar ───────────────────────────────── */}
      {activeLim?.tpm && avgDailyTokens > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="settings-label" style={{ marginBottom: 6 }}>TPM headroom</div>
          {(() => {
            // Rough: avg daily tokens ÷ active trading hours (7h) ÷ 60min
            const estTpm = Math.round(avgDailyTokens / (7 * 60))
            const pct    = Math.min(100, Math.round(estTpm / activeLim.tpm * 100))
            const color  = pct >= 80 ? '#f87171' : pct >= 50 ? '#fbbf24' : '#34d399'
            return (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginBottom: 4 }}>
                  <span>~{estTpm.toLocaleString()} TPM avg (7h trading day)</span>
                  <span>limit {activeLim.tpm.toLocaleString()} TPM · <strong style={{ color }}>{pct}% used</strong></span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .4s' }} />
                </div>
                {activeLim.rpm && (
                  <p className="text-dim" style={{ fontSize: 11, marginTop: 4 }}>
                    RPM limit: {activeLim.rpm} · RPD limit: {activeLim.rpd?.toLocaleString() ?? '—'}
                  </p>
                )}
              </div>
            )
          })()}
        </div>
      )}
      {activeLim?.note && (
        <div style={{ marginBottom: 16, padding: '8px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, fontSize: 11, color: 'var(--dim)' }}>
          📊 {activeLim.note}
        </div>
      )}

      {/* ── Quota / limits panel ──────────────────────────────────────── */}
      {quota && (() => {
        // Use selProvider (chip selection) so note/URL update when the user switches models;
        // fall back to quota.provider (active backend provider) if nothing is selected.
        const prov = (selProvider ?? quota.provider ?? '').toLowerCase()
        // Per-provider console URLs and documented free-tier limits
        const PROVIDER_META = {
          groq:    { url: 'https://console.groq.com/settings/limits',      label: 'Groq console',
                     note: 'Free tier: 30 RPM / 6,000 TPM / 14,400 RPD (model-dependent). Probe may return null headers on free plan.',
                     docLimits: [{ model: 'any', rpm: 30, tpm: 6000, rpd: 14400 }] },
          gemini:  { url: 'https://aistudio.google.com/app/apikey',        label: 'Google AI Studio',
                     note: 'Free tier: 15 RPM / 1M TPM / 1,500 RPD for gemini-3.5-flash family (see table for all models). Google AI Studio does not expose a programmatic quota API — check live usage at the link above.' },
          mistral: { url: 'https://console.mistral.ai/usage/',             label: 'Mistral console',
                     note: 'Free-tier (La Plateforme trial): 30 RPM / 100k TPM / 500 RPD per model. Mistral does not expose a usage API — monitor consumption at the console link above.' },
          ollama:  { url: null, label: null, note: 'Local model — no rate limits apply.' },
        }
        const meta = PROVIDER_META[prov] ?? { url: null, label: 'Provider dashboard', note: null }

        // Live rate-limit headers (Groq)
        const liveRows = groqLimits
          ? [
              ['Tokens limit',       groqLimits.tokens_limit],
              ['Tokens remaining',   groqLimits.tokens_remaining],
              ['Tokens reset',       groqLimits.tokens_reset],
              ['Requests limit',     groqLimits.requests_limit],
              ['Requests remaining', groqLimits.requests_remaining],
              ['Requests reset',     groqLimits.requests_reset],
            ].filter(([, v]) => v != null)
          : []

        // Free-tier model limits (Gemini, Mistral).
        // Show ALL entries regardless of chip selection so the table is always visible;
        // the row matching the selected model is highlighted.
        const freeLimitEntries = freeLimits ? Object.entries(freeLimits) : []

        return (
          <div className="usage-quota-box">
            {/* Header row: provider chip + note + dashboard link */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <span className="live-chip live-chip-model">{selProvider ?? quota.provider}</span>
              {meta.url && (
                <a href={meta.url} target="_blank" rel="noreferrer"
                   className="text-blue-link" style={{ fontSize: 12, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {meta.label} ↗
                </a>
              )}
              {/* Show our friendly meta note first; demote the raw probe note to footnote */}
              {meta.note && (
                <p className="text-dim" style={{ fontSize: 11, width: '100%', margin: '4px 0 0 0', lineHeight: 1.5 }}>
                  {meta.note}
                </p>
              )}
              {/* Only show the raw backend note when the chip matches the active backend provider,
                  so switching to a different chip doesn't bleed in stale provider messages. */}
              {quota.note && quota.note !== meta.note
               && (!selProvider || selProvider.toLowerCase() === (quota.provider ?? '').toLowerCase())
               && (
                <p className="text-dim" style={{ fontSize: 10, width: '100%', margin: '2px 0 0 0', opacity: 0.6 }}>
                  ℹ︎ {quota.note}
                </p>
              )}
            </div>

            {/* Live rate-limit headers (Groq — when available) */}
            {liveRows.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>Live metric</th><th style={{ textAlign: 'right' }}>Value</th></tr></thead>
                  <tbody>
                    {liveRows.map(([label, val], i) => (
                      <tr key={i}>
                        <td className="text-dim" style={{ fontSize: 12 }}>{label}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{val}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Free-tier documented limits (Gemini, Mistral) */}
            {freeLimitEntries.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th style={{ textAlign: 'right' }}>RPM</th>
                      <th style={{ textAlign: 'right' }}>TPM</th>
                      <th style={{ textAlign: 'right' }}>RPD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {freeLimitEntries.map(([model, lim], i) => (
                      <tr key={i} style={{ background: model === selModelName ? 'rgba(168,85,247,0.08)' : undefined }}>
                        <td className="text-dim" style={{ fontSize: 12 }}>{model}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.tpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpd?.toLocaleString() ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Groq: no live data — show documented fallback */}
            {groqLimits && liveRows.length === 0 && meta.docLimits && (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Documented free-tier limit</th>
                      <th style={{ textAlign: 'right' }}>RPM</th>
                      <th style={{ textAlign: 'right' }}>TPM</th>
                      <th style={{ textAlign: 'right' }}>RPD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.docLimits.map((lim, i) => (
                      <tr key={i}>
                        <td className="text-dim" style={{ fontSize: 12 }}>{selModelName ?? lim.model}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.tpm?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{lim.rpd?.toLocaleString() ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* quota field (Ollama / custom) */}
            {!groqLimits && !freeLimits && quota.quota && quota.quota !== 'n/a' && (
              <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>
                Quota: <strong style={{ color: '#f8fafc' }}>{quota.quota}</strong>
              </p>
            )}
          </div>
        )
      })()}
      {quotaErr && <p className="settings-err" style={{ marginTop: 8 }}>✗ Quota: {quotaErr}</p>}
    </div>
  )
}

// ─── Settings page ────────────────────────────────────────────────────────────

