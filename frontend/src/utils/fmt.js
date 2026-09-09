export function fmtTokens(n) {
  if (n == null || n === 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function fmtN(v) { return v != null ? Number(v).toFixed(2) : '—' }

export function fmtTime(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

export function fmtMarketCap(v) {
  if (v == null) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`
  return `$${Number(v).toLocaleString()}`
}

export function fmtNewsDate(epoch) {
  if (!epoch) return ''
  try {
    return new Date(epoch * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch { return '' }
}

export function fmtPct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%' }
export function fmtR(v)   { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'R' }
export function fmtNum(v) { return v == null ? '—' : v.toLocaleString() }
