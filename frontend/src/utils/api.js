export const API = import.meta.env.VITE_API_URL ?? '/api'

/** Return auth headers for every API call. Reads from sessionStorage so it is
 *  always current without needing React state. */
export function getAuthHeaders() {
  const token = sessionStorage.getItem('admin_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Called whenever the backend returns HTTP 401.
 *  Clears the stored token and fires a DOM event so App re-renders the login screen. */
export function signal401() {
  sessionStorage.removeItem('admin_token')
  window.dispatchEvent(new CustomEvent('auth-expired'))
}

// ─── SSE stream reader ────────────────────────────────────────────────────────
// Reads a POST SSE stream and yields parsed JSON payloads.
// EventSource only supports GET, so we use fetch + ReadableStream.

export async function* readSSEStream(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 401) { if (sessionStorage.getItem('admin_token')) signal401(); throw new Error('Unauthorized') }
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE events are separated by double newlines
    const parts = buf.split('\n\n')
    buf = parts.pop() // keep incomplete tail
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)) } catch { /* skip malformed */ }
        }
      }
    }
  }
}
