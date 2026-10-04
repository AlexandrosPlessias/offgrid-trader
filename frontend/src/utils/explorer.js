import { API, getAuthHeaders } from './api'

// row.opportunities / row.actionable are null for entries recorded before the
// opportunities columns existed; the stepper shows a "not stored" note for those.
export function historyRowToResult(row) {
  return {
    ticker:        row.ticker,
    analysis:      row.analysis_json,
    market_data:   row.market_snapshot,
    opportunities: row.opportunities,
    actionable:    row.actionable ?? [],
    errors:        [],
    _from_history: true,
    _history_at:   row.created_at,
  }
}

/** Open the newest saved Explorer run for *ticker*, or a prefilled Explorer if none exists. */
export async function openLatestRun(ticker, onOpenExplorer) {
  const t = String(ticker ?? '').trim().toUpperCase()
  if (!t || !onOpenExplorer) return
  try {
    const r = await fetch(`${API}/analysis/${encodeURIComponent(t)}?limit=1`, { headers: getAuthHeaders() })
    const row = r.ok ? (await r.json()).history?.[0] : null
    onOpenExplorer(row ? historyRowToResult(row) : { ticker: t })
  } catch {
    onOpenExplorer({ ticker: t })
  }
}
