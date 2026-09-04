# Security

This page documents the security design for **MarketSage** — authentication,
authorisation, API key handling, and the decisions behind each choice.

---

## Overview

| Layer | Mechanism |
|---|---|
| **Authentication** | Admin password → `POST /auth/verify` → `sessionStorage` token |
| **Authorisation** | `AdminTokenMiddleware` — Bearer token on every request |
| **API key storage** | Write-only; stored in SQLite; never returned by the API |
| **Frontend token** | `sessionStorage` (cleared on tab close) |
| **Public deployment** | `ADMIN_TOKEN` env var **must** be set via `fly secrets set` |
| **Dev / local** | `ADMIN_TOKEN` unset → middleware is a no-op; login screen auto-signs in |

---

## Login screen

When the frontend loads it checks `sessionStorage` for an `admin_token`. If none is
present it renders a **login screen** (a centred card with an app name, password
input, and Sign In button) — the rest of the app is never rendered.

### Dev mode detection

On mount, the login screen calls `POST /auth/verify` with an empty token. If the
backend responds with `{"ok": true, "dev_mode": true}` (meaning `ADMIN_TOKEN` is not
set), the input placeholder reads *"No password set — press Sign in"* and the user
can proceed without typing anything.

### Sign-in flow

1. User types the admin password and presses Sign in.
2. Frontend calls `POST /auth/verify` with `{"token": "<input>"}`.
3. On `{"ok": true, "dev_mode": false}`: token is stored in `sessionStorage` under the
   key `admin_token`; the `authed` state flips to `true`; the main app renders.
4. On HTTP 401: "Invalid password." is shown; `sessionStorage` is not written.

### Session lifetime

`sessionStorage` (not `localStorage`) is used intentionally:
- The token is **cleared automatically when the browser tab is closed**.
- The token is **not shared between tabs** — each tab has its own session.
- There is no "remember me" or persistent cookie.

---

## AdminTokenMiddleware

A Starlette `BaseHTTPMiddleware` that runs on every HTTP request to the backend.

```
Request arrives
  │
  ├─ path in {/health, /auth/verify}?
  │   └─ YES → pass through (no auth needed)
  │
  ├─ ADMIN_TOKEN configured?
  │   └─ NO → pass through (dev mode — middleware is a no-op)
  │
  ├─ Authorization: Bearer <token> header present and correct?
  │   ├─ YES → pass through
  │   └─ NO  → return HTTP 401 {"detail": "Unauthorized"}
```

### Permanently public paths

| Path | Reason |
|---|---|
| `GET /health` | Fly.io health-check probe cannot attach auth headers |
| `POST /auth/verify` | The login endpoint — must be reachable before the user authenticates |

All other routes — including `GET /settings`, `POST /analyze/stream`, `GET /signals`,
every scheduler endpoint, every paper trading endpoint — are behind the token check
when `ADMIN_TOKEN` is configured.

### Dev mode (no token configured)

When `ADMIN_TOKEN` is not set (local development), the middleware is a **no-op**: all
requests are allowed without any header. This means the app works exactly as before
with no extra setup. For public deployments `ADMIN_TOKEN` must be set.

---

## API key masking

### Write-only design

API keys (GROQ_API_KEY, GEMINI_API_KEY, ALPACA_API_SECRET_KEY, etc.) and the
`admin_token` are **never returned by the API**. Specifically:

- `GET /settings` returns boolean flags (`llm_api_key_set: true/false`,
  `alpaca_secret_set: true/false`) but never the raw values.
- `admin_token` is not included in `GET /settings` at all — even as a boolean.
- The endpoints `GET /settings/llm/key` and `GET /settings/alpaca/secret` **do not
  exist** — they were removed. Any request to those paths returns HTTP 404.

### Rationale

Even with middleware-level auth, returning plaintext secrets to the browser means any
authenticated session (shared machine, borrowed laptop, XSS) can exfiltrate live API
keys. Write-only secrets are the correct design:

- To **verify** a key is set: the Settings page shows ✓/✗ based on the boolean flag.
- To **verify** the exact value: use `fly secrets list` in the terminal (Fly shows the
  secret name but not the value — this is the appropriate place to confirm a key exists).
- To **rotate** a key: paste a new value in the Settings page and save, or re-run
  `fly secrets set KEY=new-value`.

---

## CORS

The backend sets `CORS_ORIGINS` to the Vercel domain only for public deployments.
This prevents cross-origin calls from arbitrary websites. For local development,
`CORS_ORIGINS` can remain the wildcard default.

```bash
fly secrets set CORS_ORIGINS=https://offgrid-trader.vercel.app
```

---

## Security checklist for public deployment

- [ ] `ADMIN_TOKEN` set to a strong random secret (`openssl rand -hex 32`)
- [ ] `CORS_ORIGINS` set to your Vercel domain only
- [ ] All API keys set via `fly secrets set` (never in `fly.toml` or source code)
- [ ] `fly.toml` committed to the repo — confirm it contains **no** secret values
- [ ] `GET /health` tested without `Authorization` header — must return 200
- [ ] `GET /settings` tested without `Authorization` header — must return 401
- [ ] Browser DevTools → Application → Session Storage — confirm `admin_token` stored after login
- [ ] Browser DevTools → Application → Session Storage — confirm `admin_token` cleared after tab close

---

## Related pages

- [Architecture](architecture.md) — AdminTokenMiddleware in the request flow diagram
- [Settings reference](settings.md) — ADMIN_TOKEN env var, fallback provider
- [Cloud hosting](cloud-hosting.md) — Fly.io + Vercel account guide
- [Development guide](development.md) — deploying to Fly.io + Vercel
