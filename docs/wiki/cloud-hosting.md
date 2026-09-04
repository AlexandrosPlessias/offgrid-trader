# Cloud accounts setup

Step-by-step guide to opening **Fly.io** and **Vercel** accounts and doing the
one-time CLI setup required before the GitHub Actions CD pipeline takes over.

> You only need to do this **once**. After this guide, every push to `main`
> deploys automatically via `.github/workflows/deploy.yml`.

---

## Prerequisites

Install these CLI tools before starting (all free):

| Tool | Install | Purpose |
|---|---|---|
| `flyctl` | `curl -L https://fly.io/install.sh \| sh` (Linux/macOS) or `winget install flyctl` (Windows) | Deploy and manage the Fly.io backend |
| `vercel` | `npm install -g vercel` | Deploy and manage the Vercel frontend |
| `gh` | https://cli.github.com/ | Set GitHub Actions secrets |
| `jq` | `sudo apt install jq` / `brew install jq` | Parse Vercel project IDs in the setup script |

---

## Part 1 — Fly.io (backend)

> **Important:** all `fly` / `flyctl` commands must be run from the **repo root**
> (the directory that contains `fly.toml`). If you run them from another directory,
> Fly cannot find the app config and returns *"missing an app name"*.
> ```bash
> cd /path/to/offgrid-trader   # always start here
> ```
> Alternatively, append `-a offgrid-trader` to any command to target the app explicitly
> without needing to be in the repo root.

### 1. Create a Fly.io account

1. Go to **https://fly.io** and click **Get started**.
2. Sign up with GitHub, Google, or email.
3. The free **Hobby** plan is enough: you get 3 shared-CPU VMs (256 MB RAM each)
   at no cost. A credit card is required only if you add resources beyond the free
   allowances — the one VM used by this app stays free.

### 2. Install and authenticate the CLI

```bash
# Linux / WSL2
curl -L https://fly.io/install.sh | sh

# macOS (Homebrew)
brew install flyctl

# Authenticate
flyctl auth login   # opens a browser tab
```

### 3. Create the app

From the repo root (where `fly.toml` lives):

```bash
# Pick a globally-unique name — the URL will be https://<name>.fly.dev
fly apps create offgrid-trader
```

If `offgrid-trader` is taken, choose another name and update the `app` field in
`fly.toml`:

```toml
app = "your-chosen-name"
```

### 4. Create the persistent volume

SQLite data lives on a Fly volume (survives deploys and restarts):

```bash
fly volumes create offgrid_trader_data --region lhr --size 1
```

`lhr` = London. Choose a region close to your users. See
`flyctl platform regions` for all options.

### 5. Set runtime secrets

```bash
fly secrets set \
  ADMIN_TOKEN=$(openssl rand -hex 32) \
  DATABASE_PATH=/app/data/offgrid_trader.db \
  LLM_PROVIDER=gemini \
  GEMINI_API_KEY=AIza... \
  GEMINI_MODEL=gemini-3.5-flash-lite \
  GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \
  LLM_FALLBACK_PROVIDER=groq \
  LLM_FALLBACK_MODEL=qwen/qwen3.6-27b \
  GROQ_API_KEY=gsk_... \
  GROQ_MODEL=qwen/qwen3.6-27b \
  FINNHUB_API_KEY=... \
  FRED_API_KEY=... \
  ALPACA_PAPER_URL=https://paper-api.alpaca.markets/v2 \
  ALPACA_API_KEY_ID=... \
  ALPACA_API_SECRET_KEY=... \
  CONFIDENCE_FLOOR=75 \
  CORS_ORIGINS=https://PLACEHOLDER.vercel.app
```

> - Replace `...` values with your actual keys from `.env`.
> - Update `CORS_ORIGINS` in step 7 once you know your Vercel domain.
> - Copy the generated `ADMIN_TOKEN` to a password manager — you will need it to log in.
> - `DATABASE_PATH` must point to the mounted volume path, **not** the local `.env` value.

### 6. First manual deploy

```bash
flyctl deploy   # uses fly.toml in the current directory
```

This builds the Docker image on Fly's infrastructure and starts the machine. Watch
the output — a green `✓ Deployed successfully` confirms it worked.

```bash
# Verify the health check passes
curl https://offgrid-trader.fly.dev/health
# → {"status":"ok"}
```

### 7. Note your Fly.io app URL

`https://<your-app-name>.fly.dev` — you will need this for Vercel's `VITE_API_URL`.

---

## Part 2 — Vercel (frontend)

### 1. Create a Vercel account

1. Go to **https://vercel.com** and click **Sign Up**.
2. Sign up with GitHub (recommended — Vercel can then import repos directly).
3. The **Hobby** tier is free: unlimited personal projects, 100 GB bandwidth/month.

### 2. Install and authenticate the CLI

```bash
npm install -g vercel

vercel login   # opens a browser tab
```

### 3. Link the frontend project

Run from the **repo root** (not the `frontend/` subdirectory):

```bash
cd frontend && npx vercel link
```

Follow the prompts:
- **Set up and deploy "~/offgrid-trader/frontend"?** → `Y`
- **Which scope?** → select your personal account or team
- **Link to existing project?** → `N` (first time) or `Y` if you already created one in the Vercel web UI
- **What's your project's name?** → `offgrid-trader` (or any name you like)
- **In which directory is your code located?** → `./` (already in `frontend/`)

This creates `frontend/.vercel/project.json` with `orgId` and `projectId`.

> `.vercel/project.json` is gitignored — do not commit it.

### 4. Add the backend URL as a production env var

```bash
# Still in frontend/
npx vercel env add VITE_API_URL production
# Enter: https://offgrid-trader.fly.dev  (or your chosen Fly app URL)
```

This value is baked into the React bundle at Vercel build time. For local development
it falls back to `/api` (Vite dev proxy) automatically — no local `.env` change needed.

### 5. First manual deploy

```bash
npx vercel --prod   # from frontend/
```

Watch for `✅ Production:  https://offgrid-trader.vercel.app` (or similar). Open
that URL — you should see the MarketSage login screen.

### 6. Note your Vercel domain and update CORS_ORIGINS

```bash
# Back in repo root — update the CORS allowed origin on Fly
fly secrets set CORS_ORIGINS=https://offgrid-trader.vercel.app
```

Replace `offgrid-trader.vercel.app` with your actual Vercel domain if it differs.

---

## Part 3 — Wire GitHub Actions

Run the setup script **once** from the repo root:

```bash
bash scripts/setup-gh-secrets.sh
```

Prerequisites (all must be authenticated):
- `flyctl` — step 2 above
- `vercel` — step 2 above (Part 2)
- `gh` — `gh auth login`
- `jq` — installed

The script:
1. Creates a 1-year Fly.io deploy token and sets `FLY_API_TOKEN`.
2. Reads `frontend/.vercel/project.json` and sets `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID`.
3. Prompts once for your Vercel personal access token (create at
   **https://vercel.com/account/tokens**) and sets `VERCEL_TOKEN`.

> Create the token under **Account Settings → Tokens**, scoped to your team.
> Tokens created elsewhere (for example project-level tokens) are rejected — the
> CLI cannot read project settings with them, and `vercel pull` fails in CI.

Verify:

```bash
gh secret list --repo <org>/<repo>
# Should list: FLY_API_TOKEN, VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID
```

---

## Verification

### End-to-end smoke test

1. Push any commit to `main`:
   ```bash
   git push origin main
   ```
2. Watch GitHub Actions: both `Backend → Fly.io` and `Frontend → Vercel` jobs should go green.
3. Open your Vercel URL → login screen appears → enter your `ADMIN_TOKEN` → app loads.
4. Open **Settings → 🧠 AI Provider** → confirm the provider is shown and the "Key is set ✓" indicator appears.
5. Run an analysis from the Explorer tab — confirm results stream back.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Health check returns 503 | Volume not created | `fly volumes list` — create if missing |
| Login says "Invalid password" | Wrong `ADMIN_TOKEN` | `fly secrets list` to confirm it's set; re-run `fly secrets set ADMIN_TOKEN=...` |
| Frontend shows blank page | `VITE_API_URL` not set in Vercel | `vercel env ls` → check production env |
| CORS error in browser console | `CORS_ORIGINS` not set to Vercel domain | `fly secrets set CORS_ORIGINS=https://<domain>` |
| Alpaca account shows empty / no orders placed | `ALPACA_PAPER_URL` missing `/v2` suffix | `fly secrets set ALPACA_PAPER_URL=https://paper-api.alpaca.markets/v2` |
| Paper orders never trigger despite signals | `ALPACA_PAPER_URL` wrong **or** `paper_trading_enabled` is `false` | Fix URL (above); enable paper trading in Settings → Paper Trading |
| GitHub Actions job fails | Missing secrets | `gh secret list` — re-run `scripts/setup-gh-secrets.sh` |

---

## Related pages

- [Development guide](development.md) — day-to-day deploy runbook
- [Security](security.md) — admin token, login screen, write-only key design
- [Cloud LLM providers](cloud-llm.md) — Groq, Gemini, Mistral setup + quota fallback
- [Architecture](architecture.md) — cloud deployment diagram
