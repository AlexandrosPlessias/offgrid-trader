# Cloudflare Workers Cron Trigger

MarketSage uses a **Cloudflare Workers Cron Trigger** to start and stop the Fly.io backend and
send end-of-day / weekly reports on a reliable schedule fully independent of the backend's uptime.
If the backend is cold-starting, calls are retried automatically (3 attempts × 10 s).

Scans are managed entirely by the in-process `MonitorScheduler` — the Worker does **not** trigger
individual scan ticks.

---

## What it does

| Cron (UTC) | ET time | Season | Action |
|---|---|---|---|
| `30 12 * * MON-FRI` | 8:30 AM ET | EDT (summer) | Start the Fly app |
| `30 13 * * MON-FRI` | 8:30 AM ET | EST (winter) | Start the Fly app |
| `5 21 * * MON-FRI` | 5:05 PM ET | EDT / 4:05 PM EST | EoD reports (orders **and** frac) → ntfy + Telegram |
| `30 21 * * MON-FRI` | 5:30 PM ET | EDT / 4:30 PM EST | Stop the Fly app |
| `25 21 * * FRI` | 5:25 PM ET Fri | EDT / 4:25 PM EST | Weekly reports (orders **and** frac) |

> **Always use day names, never numbers.** The numeric form runs a day behind here: the
> weekly cron `25 21 * * 5` fired on **Thursday**, and switching only that one to `FRI`
> made it fire on Friday — same slot, same worker, so the day format was the only
> variable. By the same shift `1-5` resolved to **Sunday–Thursday**, which silently
> skipped every Friday: no EoD report, no stop, no start. All five schedules now use
> three-letter names, which Cloudflare stores verbatim so `resolveAction()` matches them
> exactly.

The EoD and weekly actions each make **two** sequential backend calls — `/reports/eod/orders`
then `/reports/eod/frac` (and the weekly equivalents) — so both notifications land.

**DST handling** — the free plan allows 5 cron triggers per account. Start uses dual EDT/EST twins
so the app wakes at exactly 8:30 AM ET year-round. The three evening jobs use a single EDT-based
cron; in winter (EST) they fire ~1 h early but always after market close (4 PM ET), so the drift
is harmless.

**Each job is independent** — EoD failing never blocks the stop, and the stop never waits for EoD.

---

## Files

```
infra/cron-worker/
├── wrangler.toml       — Worker name, cron schedules, observability config
├── src/index.js        — scheduled handler: DST resolver, Fly Machines API, backend calls
├── set-secrets.sh      — one-shot script to push all secrets from .env to Cloudflare
└── .dev.vars           — local-only secrets for wrangler dev (gitignored, auto-generated)
```

---

## Starting the Fly machine

`startApp()` starts every stopped machine. If the app has **no machines at all** — for
example after a failed deploy destroyed the last one — it recreates one by cloning the
most recent machine's config (`GET /machines?include_deleted=true`) and swapping in the
image from the latest successful release.

Cloning matters: a hand-written config would omit the volume mount, the `[[services]]`
port handlers and the `[env]` block, producing a machine that boots but has **no database
and serves no traffic** — so every later `/reports/*` call would fail against an app that
looks "started". As a backstop, the Worker refuses to create a machine whose template has
no volume mount, and logs that a manual `fly deploy` is required instead.

### DST resolution

`easternOffset()` compares the current UTC hour against the same instant rendered in
`America/New_York` to decide whether the account is on EDT (`-0400`) or EST (`-0500`).
It formats with `hourCycle: "h23"` rather than `hour12: false`, because the `en-US`
locale defaults to the `h24` cycle, which renders midnight as `"24"` and would skew the
computed offset by a full day for any job scheduled in the `00:xx` UTC hour.

---

## Prerequisites

- **Cloudflare account** — free tier (100k requests/day, 5 cron triggers).
- **Node.js ≥ 18** and **Wrangler 4** — already installed if you cloned the repo.
- **Fly deploy token** — scoped to this app only:
  Fly.io dashboard → **offgrid-trader** app → **Settings → Tokens → Create deploy token**.
  Use a deploy token (not an org token) — it can only touch this one app.
- **MarketSage admin token** — Settings → Authentication in the UI.

---

## First-time setup

### 1 — Add secrets to `.env`

Open the project root `.env` and fill in the two Cloudflare-specific lines:

```env
CRON_WORKER_FLY_API_TOKEN=your-fly-deploy-token
CRON_WORKER_FLY_APP_NAME=offgrid-trader
```

`ADMIN_TOKEN` and `BACKEND_PUBLIC_URL` are already in `.env` and are read automatically.

### 2 — Log in to Cloudflare

```bash
cd infra/cron-worker
npx wrangler login
```

Opens a browser tab — approve access. One-time per machine.

### 3 — Open Workers & Pages in the dashboard (one-time)

Go to [dash.cloudflare.com](https://dash.cloudflare.com) → click **Workers & Pages** in the
sidebar. This creates the `workers.dev` subdomain required for cron triggers to register.

### 4 — Push secrets and deploy

```bash
cd infra/cron-worker
./set-secrets.sh    # reads from .env, prompts only for anything missing
npx wrangler deploy
```

### 5 — Optional GitHub Actions auto-deploy

The repo includes `/home/runner/work/offgrid-trader/offgrid-trader/.github/workflows/deploy-cloudflare-cron.yml`.
It deploys automatically on `main` pushes that touch `infra/cron-worker/**`, and can also be run manually.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN` — API token with Workers Scripts edit permission for this account
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID that owns `offgrid-trader-cron`

Expected output:
```
Deployed offgrid-trader-cron triggers (4.93 sec)
  schedule: 30 12 * * MON-FRI
  schedule: 30 13 * * MON-FRI
  schedule: 5 21 * * MON-FRI
  schedule: 30 21 * * MON-FRI
  schedule: 25 21 * * FRI
```

---

## Testing locally

`wrangler dev` uses `.dev.vars` instead of Cloudflare secrets. Generate it once from `.env`:

```bash
cd infra/cron-worker
./set-secrets.sh   # already done above — .dev.vars is written as a side-effect
```

Or regenerate manually:
```bash
# From the project root:
bash -c '
  source .env 2>/dev/null || true
  echo "ADMIN_TOKEN=$(grep -E "^ADMIN_TOKEN=" .env | cut -d= -f2-)"    > infra/cron-worker/.dev.vars
  echo "BACKEND_URL=$(grep -E "^BACKEND_PUBLIC_URL=" .env | tail -1 | cut -d= -f2- | sed "s|/$||")" >> infra/cron-worker/.dev.vars
  echo "FLY_API_TOKEN=$(grep -E "^CRON_WORKER_FLY_API_TOKEN=" .env | cut -d= -f2-)"                >> infra/cron-worker/.dev.vars
  echo "FLY_APP=$(grep -E "^CRON_WORKER_FLY_APP_NAME=" .env | cut -d= -f2-)"                       >> infra/cron-worker/.dev.vars
'
```

Then simulate any cron:

```bash
# Terminal 1 — start local dev server
cd infra/cron-worker
npx wrangler dev --test-scheduled

# Terminal 2 — fire a simulated cron tick
curl "http://localhost:8787/__scheduled?cron=5+21+*+*+MON-FRI"   # EoD
curl "http://localhost:8787/__scheduled?cron=30+21+*+*+MON-FRI"  # stop
curl "http://localhost:8787/__scheduled?cron=30+12+*+*+MON-FRI"  # start
curl "http://localhost:8787/__scheduled?cron=25+21+*+*+FRI"  # weekly
```

Watch the output in terminal 1.

---

## Tuning schedules

Edit the `crons` array in [`wrangler.toml`](../../infra/cron-worker/wrangler.toml) and the
`resolveAction` function in [`src/index.js`](../../infra/cron-worker/src/index.js), then redeploy:

```bash
cd infra/cron-worker
npx wrangler deploy
```

**Free plan limit: 5 cron triggers per account.** Current usage: 5/5.
To add more triggers you either need to consolidate (e.g. combine two actions in one handler) or
upgrade to Workers Paid (1,000 triggers/account, ~$5/month).

### Changing ET times

The Worker uses `Intl.DateTimeFormat` with `timeZone: "America/New_York"` to derive the current
ET offset — no manual DST math needed. To shift a job:

1. Change the UTC cron string in `wrangler.toml`.
2. Update the matching `cron === "..."` check in `resolveAction()` in `src/index.js`.
3. Redeploy.

Example — move EoD from 5:05 PM to 4:35 PM ET (EDT = 20:35 UTC):
```toml
# wrangler.toml
"35 20 * * MON-FRI",   # EoD — EDT 4:35 PM ET
```
```js
// src/index.js — resolveAction
if (cron === "35 20 * * MON-FRI") return "eod";
```

### Adding a new job

1. Add the cron string to `wrangler.toml` (stay ≤ 5 total).
2. Add a `return "myjob"` case to `resolveAction()`.
3. Add an `if (action === "myjob") { ... }` block in the `scheduled` handler.
4. Redeploy.

---

## Viewing logs

**Live stream (CLI):**
```bash
cd infra/cron-worker
npx wrangler tail
```

**Persistent (dashboard):**
Workers & Pages → **offgrid-trader-cron** → **Logs** tab — searchable, 3-day history.

## Viewing traces

Workers & Pages → **offgrid-trader-cron** → **Observability/Traces**.

Observability is already enabled in `wrangler.toml` (`head_sampling_rate = 1` = 100% sampled),
so both logs and traces are emitted for each invocation.

### Cost

- Cloudflare Workers Free includes basic logs/traces for this setup.
- Practical free limits (as configured here): 5 cron triggers/account, log retention around 3 days.
- If you exceed free quotas or need higher retention, Cloudflare paid plans apply.

Each invocation logs:
- Cron string that fired + resolved ET offset + resolved action
- Whether the start/stop/eod/weekly branch ran or was a noop
- HTTP status of every Fly Machines API / backend call, with retry attempt numbers

---

## Rotating secrets

```bash
cd infra/cron-worker
./set-secrets.sh   # re-reads from .env — empty answer skips that secret
```

Or individually:
```bash
npx wrangler secret put ADMIN_TOKEN      # after rotating the MarketSage token
npx wrangler secret put FLY_API_TOKEN    # after rotating the Fly deploy token
```

Secrets take effect immediately — no redeploy needed.

---

## Relationship with `app-power.yml`

`app-power.yml` is now **manual-only** (`workflow_dispatch`). The Worker owns the automatic
schedule. They are independent — a manual `app-power.yml` run (start or stop) is always safe
alongside the Worker, since the Fly Machines API is idempotent for both actions.

---

## Why Cloudflare Workers

| Option | Decision | Reason |
|---|---|---|
| **Cloudflare Workers cron** | **Chosen** | Free, independent of Fly uptime, secrets stay off third parties, built-in observability, retry logic |
| GitHub Actions cron | Rejected | Delayed/skipped under load; already used by `app-power.yml` — stacking report timing on it compounds risk |
| cron-job.org | Rejected | Stores `BACKEND_URL` + `ADMIN_TOKEN` on a third party, against the project's self-hosted ethos |

See [`BACKLOG.md § 8`](../../BACKLOG.md) for the full decision record.
