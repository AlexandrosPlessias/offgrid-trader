# Notifications

MarketSage sends **one push alert per signal** as each scan cycle turns it up —
one message per opportunity, with action buttons for placing a trade directly
from your phone.

Three channels are available. All are off by default and independently
enabled:

| Channel | Delivery | Credentials | Privacy |
|---|---|---|---|
| **ntfy** (recommended) | Push notification (mobile + browser) | None — topic name is the only secret | Self-hosted on your own infrastructure |
| **Telegram** | Bot message with inline buttons | BotFather token + chat ID | Sent via Telegram's servers |
| ~~**Email**~~ | *Descoped* | — | No longer wired into the send path — ntfy/Telegram cover the same cases |

> ⚠️ **Not financial advice.** Signals are for educational/research purposes only.
> The **Order** button trades on your **paper** account; the **Frac** button can
> place **real** money when the fractional engine runs in `live` mode (the tap is
> the confirmation).

---

## ntfy — push notifications (no sign-up required)

[ntfy](https://ntfy.sh) is a free, open-source push-notification service. A
**topic name** acts as your private channel — anyone who knows it can subscribe,
so pick a long random string.

### How ntfy runs in this project

ntfy runs **inside your own infrastructure** — no data leaves your machines:

| Deployment | Where ntfy runs | Subscribe URL |
|---|---|---|
| **Local Docker** | `ntfy` container in the shared `ai-shared` stack (port 18880) | `http://<host-ip>:18880/<topic>` |
| **Fly.io (cloud)** | Sidecar process inside the same backend container | `https://<app>.fly.dev:18880/<topic>` |

### 1. Generate a topic name

```bash
openssl rand -hex 12
# example output: a1b2c3d4e5f6a1b2c3d4e5f6
```

Use the output as your `NTFY_TOPIC`. Keep it secret — share it only with the
devices you want to receive alerts.

### 2. Subscribe in the ntfy app

Install the free **ntfy app** on your phone (Android / iOS) or open
[ntfy.sh](https://ntfy.sh) in a browser.

| Platform | Link |
|---|---|
| Android | [Google Play](https://play.google.com/store/apps/details?id=io.heckel.ntfy) |
| iOS | [App Store](https://apps.apple.com/us/app/ntfy/id1625396347) |
| Browser | Open the subscribe URL directly in Chrome / Firefox |

Add a subscription pointing at **your** server (not the default ntfy.sh):

- Local Docker: `http://<host-ip>:18880/<your-topic>`
- Fly.io cloud: `https://<app>.fly.dev:18880/<your-topic>`

> **Finding your host IP on WSL2:** run `hostname -I | awk '{print $1}'` inside
> WSL. Use this IP from your phone when both are on the same LAN.

### 3. Enable via the Settings page (recommended)

Both active channels (ntfy, Telegram) live in one place: **Settings** (⚙) → **Notifications**. Each row
shows a **● configured / ○ not configured** chip, has its own **Save**, a **Load env**
button (pulls the `.env`/secret defaults into the form), and there's a single
**🔔 Send test to all enabled channels** button at the bottom.

### Round-trip test confirmation

The **Send test** message includes a **✅ Confirm receipt** action (an ntfy action
button and a Telegram inline button). Tapping it proves the *whole* loop —
credentials → delivery → action routing → frontend feedback — in one click:

1. The test carries a **single-use token** (TTL 60 s).
2. Tapping the button calls `POST/GET /notifications/test/confirm?token=<uuid>`
   (no auth — the token is the proof; ntfy uses POST, a Telegram URL button opens
   a browser GET).
3. Settings polls `/notifications/test/status?token=` and updates inline:
   **⏳ Waiting for confirmation…** → **✅ Round-trip confirmed** (or, after 60 s,
   **⚠ No response received**).

> The confirm link points at `BACKEND_PUBLIC_URL`, so the round-trip only completes
> when your backend is reachable from the device that taps the button (a public URL,
> not `localhost`). Delivery still works locally; only the confirm hop needs reachability.

### Order & fractional placement notifications

A separate toggle — **Order & fractional notifications** (default **on**) — pushes a
short message to your channels each time an order or fractional buy is placed
(e.g. `🪙 Fractional buy placed — BUY AAPL · $15.00 · LIVE 💰`, or
`📈 Order placed — BUY AAPL · $500.00 · paper`).

For ntfy:
1. Toggle **Enable** on.
2. Paste your **Topic**.
3. Set the **Server** — see the critical note below.
4. Click **Save**, then **Send test**.

Changes are stored in the database and take effect **immediately — no restart**.
DB values set here override the `.env`/secret defaults.

> ### ⚠️ Server field vs. subscribe URL — the #1 mistake
> The **Server** field is where the *backend* publishes, so it must be the
> **internal** address (backend and ntfy run in the same network):
>
> | Deployment | Server field (in Settings) |
> |---|---|
> | Local Docker | `http://ntfy:80` |
> | Fly.io | `http://localhost:18880` |
>
> Do **not** put the public `https://<app>.fly.dev:18880/...` URL here — that
> makes the backend loop out through the internet and doubles the topic onto the
> path. The public URL is used **only** in your phone's ntfy app subscription,
> never in the Server field.

### 4. Enable via `.env` (alternative)

```env
NTFY_ENABLED=true
NTFY_TOPIC=a1b2c3d4e5f6a1b2c3d4e5f6

# Local Docker — connects over the ai-shared Docker network:
NTFY_SERVER=http://ntfy:80

# Fly.io sidecar — ntfy is on the same machine as the backend:
NTFY_SERVER=http://localhost:18880  # (set automatically via fly.toml)

# Your backend's public URL — embedded in action button URLs:
BACKEND_PUBLIC_URL=http://localhost:8010        # local
# BACKEND_PUBLIC_URL=https://offgrid-trader.fly.dev  # Fly.io
```

After editing `.env` run `make up` to recreate the container.

### 5. Notification format

MarketSage sends **one alert per signal**, the moment a scan cycle turns one up.
Each alert looks like this on your phone:

```
Title:  MarketSage · LONG AAPL · 78% confidence
Body:
  Ticker:     AAPL
  Direction:  LONG
  Confidence: 78%
  Price:      190.12
  Entry:      190.00
  Stop:       185.00
  Target:     200.00
  Source:     ai+rsi_extreme

  Reasons:
    - AI flagged long setup
    - RSI oversold on 4H, 1D

  Not financial advice · Generated locally by MarketSage

  [Order AAPL BUY]   [Frac AAPL]
```

Each alert carries up to **two from-phone trade actions**:

- **Order** — places a bracket order via `POST /paper/orders/place` on your
  **paper** account, using the signal's entry / stop / target. Shown for both
  **LONG** and **SHORT** signals (ntfy action `Order {TICKER} {SIDE}`).
- **Frac** — places a fractional buy via `POST /frac/order`. Shown for **LONG**
  signals only — the fractional engine is buy-only (ntfy action `Frac {TICKER}`).
  ⚠️ When that engine is in `live` mode the tap places a **real** order; the tap
  itself is the confirmation.

Both buttons hit the same endpoints the UI uses, so orders run through the
identical dedup, tradability, and budget-cap checks — no shortcuts.

> ntfy tags each notification by kind — a chart icon on signal alerts, a
> bar-chart on the end-of-day digest, a rocket on startup — so they're easy to
> tell apart at a glance.

### 6. Cloud (Fly.io) specifics

ntfy runs as a **sidecar** in the same container as the backend (started by
`infra/entrypoint.sh`). The relevant `fly.toml` config:

```toml
[env]
  NTFY_SERVER   = "http://localhost:18880"                 # backend → sidecar (internal)
  NTFY_BASE_URL = "https://offgrid-trader.fly.dev:18880"   # ntfy's public URL (for the app)

# The sidecar port uses a tls-ONLY handler (not "http"):
[[services]]
  internal_port = 18880
  [[services.ports]]
    port     = 18880
    handlers = ["tls"]
```

> **Why `handlers = ["tls"]` and not `["tls", "http"]`?** The `http` handler makes
> Fly negotiate **HTTP/2** on the port. WebSocket's upgrade handshake is
> HTTP/1.1-only, so the ntfy app fails with *"websocket upgrade failed / 404"*.
> With `tls` only, Fly terminates TLS and passes the raw stream to ntfy, which
> speaks HTTP/1.1 and handles the WebSocket upgrade itself.

Set the topic on Fly (your local `.env` does **not** apply there):

```bash
fly secrets set NTFY_ENABLED=true NTFY_TOPIC=<your-topic>
```

Then subscribe on your phone to `https://<app>.fly.dev:18880/<your-topic>`.

---

## Telegram — bot messages with inline buttons

### 1. Create a bot via BotFather

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the prompts.
3. Copy the **token** (format: `123456789:AAF...`).

### 2. Get your chat ID

1. Start a chat with your new bot (search for its username → press **Start**).
2. Send any message (e.g. `hello`).
3. Fetch updates — replace `<TOKEN>` with your bot token:
   ```bash
   curl https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. In the JSON response find `"chat": {"id": 123456789}` — that number is your
   `TELEGRAM_CHAT_ID`. For a group chat the ID is negative (e.g. `-987654321`).

### 3. Configure

**Settings page:**

1. Open **Settings** → **Notifications** → **Telegram**.
2. Paste the bot token and chat ID, toggle enabled, and click **Save**.

**`.env`:**

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456789:AAF...
TELEGRAM_CHAT_ID=123456789
```

### 4. Inline keyboard buttons (trade from phone)

Telegram alerts arrive as **HTML**, with the aligned signal body wrapped in a
monospace `<pre>` block so the columns line up. Below each message sits an
inline keyboard carrying the same **two trade actions** as ntfy:

```
MarketSage · LONG AAPL · 78% confidence

  Ticker:     AAPL
  Direction:  LONG
  …

[📄 Order BUY AAPL]
[🪙 Frac AAPL]
```

- **📄 Order {SIDE} {TICKER}** — bracket order on the **paper** account
  (`POST /paper/orders/place`). Shown for **LONG** and **SHORT** signals.
- **🪙 Frac {TICKER}** — fractional buy (`POST /frac/order`), **LONG** signals
  only. Places a **real** order when the fractional engine is in `live` mode.

Tapping a button triggers `POST /notifications/telegram/callback`, which drives
the same endpoints — and the same validation — as the UI.

#### Register the callback webhook (one-time, cloud only)

For Telegram button taps to reach your backend the bot must be configured with
a webhook pointing at your public URL:

```bash
# Replace <TOKEN> and <YOUR_BACKEND_URL>:
curl https://api.telegram.org/bot<TOKEN>/setWebhook \
     -d "url=https://<your-backend>/notifications/telegram/callback" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Set `TELEGRAM_WEBHOOK_SECRET` to any random string (e.g. `openssl rand -hex 16`)
and add it to your Fly.io secrets:

```bash
fly secrets set TELEGRAM_WEBHOOK_SECRET=<your-secret>
```

> **Local use:** Telegram cannot reach `localhost`. For local testing either
> skip the webhook (buttons won't work, but alerts still arrive) or use a
> tunnel like [ngrok](https://ngrok.com/).

---

## Email — Gmail SMTP (descoped)

> ⚠️ **Email is descoped.** It is no longer wired into the notification send path
> — signals, order/fractional placements, and the round-trip test all go via ntfy
> and Telegram only. The SMTP code and config below are retained but inert; the
> Settings UI section is commented out. The steps remain for reference if you
> re-enable `send_email()` in `backend/alerts.py`.

### Setup

1. Enable **2-Step Verification** on your Google account.
2. Create an **App Password**: https://myaccount.google.com/apppasswords
   (Security → 2-Step Verification → App passwords).
3. Configure `.env`:
   ```env
   EMAIL_ENABLED=true
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USERNAME=your_address@gmail.com
   SMTP_APP_PASSWORD=xxxx xxxx xxxx xxxx    # 16-char App Password
   EMAIL_FROM=your_address@gmail.com
   EMAIL_TO=recipient@example.com
   ```

Email does **not** have inline action buttons. Use ntfy or Telegram for
paper-trade taps.

### Global "Alert dispatch" switch

The **Alert dispatch** toggle at the top of the Notifications section gates
**email** delivery — turn it off to suspend email without editing `EMAIL_ENABLED`
(useful during testing). Telegram and ntfy are unaffected; they use their own
enable flags. Via the API:

```bash
curl -X POST http://localhost:8010/settings/alerts \
     -H "Content-Type: application/json" \
     -d '{"enabled": false}'
```

---

## API reference

> All routes require `Authorization: Bearer <ADMIN_TOKEN>` when `ADMIN_TOKEN`
> is set (always the case on public/Fly deployments).

### GET /settings/notifications

Returns the effective config for **all** channels. Secrets are never returned in
plain text — only `*_set` booleans. `*_env` fields show the `.env`/secret defaults
(DB ignored) for the "Load env" buttons.

```bash
curl http://localhost:8010/settings/notifications
```

```json
{
  "alerts_enabled": true,
  "ntfy_enabled": true, "ntfy_topic_set": true,
  "ntfy_server": "http://localhost:18880", "ntfy_configured": true,
  "telegram_enabled": false, "telegram_bot_token_set": false,
  "telegram_chat_id": "", "telegram_configured": false,
  "email_enabled": false, "email_configured": false,
  "email_smtp_host": "smtp.gmail.com", "email_smtp_port": 587
}
```
(`*_configured` means the credentials are present — independent of the enable toggle.)

### POST /settings/notifications/{ntfy,telegram,email}

Update a channel's settings at runtime (no restart). All fields optional; secrets
are only overwritten when a non-empty value is sent.

```bash
curl -X POST http://localhost:8010/settings/notifications/ntfy \
     -H "Content-Type: application/json" \
     -d '{"enabled": true, "topic": "a1b2c3d4e5f6", "server": "http://localhost:18880"}'

curl -X POST http://localhost:8010/settings/notifications/telegram \
     -H "Content-Type: application/json" \
     -d '{"enabled": true, "bot_token": "123:AAF...", "chat_id": "123456789"}'
```

### POST /notifications/test

Fires a test notification through **every enabled channel** and reports per-channel
results. ntfy accepts optional `topic`/`server` overrides (to test unsaved form
values); Telegram/Email use their saved config.

```bash
curl -X POST http://localhost:8010/notifications/test \
     -H "Content-Type: application/json" -d '{}'
# → {"ok": true, "results": {"ntfy": "sent", "telegram": "skipped or failed", ...}}
```

### POST /notifications/telegram/callback

Telegram webhook endpoint — called automatically by Telegram when the user taps
an inline button. Register it via `setWebhook` (see [Telegram setup](#register-the-callback-webhook-one-time-cloud-only)).

---

## Verifying notifications work

**Easiest:** Settings → Notifications → **🔔 Send test to all enabled channels**.
It reports per-channel results (`ntfy: sent · telegram: skipped or failed · …`).

Or via the API:

```bash
curl -X POST http://localhost:8010/notifications/test \
     -H "Authorization: Bearer <ADMIN_TOKEN>" \
     -H "Content-Type: application/json" -d '{}'
```

You can also confirm ntfy end-to-end by polling the topic directly:

```bash
curl "http://localhost:18880/<your-topic>/json?poll=1&since=all"
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Send test → 502 "No channel accepted" | The **Server** field holds the public URL instead of the internal one | Set Server to `http://ntfy:80` (Docker) or `http://localhost:18880` (Fly), not `https://<app>.fly.dev:18880/...` |
| ntfy notification not received | App subscribed to wrong server or topic | Subscribe to `http://<host-ip>:18880/<topic>` (Docker) or `https://<app>.fly.dev:18880/<topic>` (Fly) |
| ntfy container not starting | Port 18880 already in use | `ss -tlnp \| grep 18880` — stop the conflicting process or change the host port in `docker-compose.infra.yml` |
| Mobile app: "websocket upgrade failed / 404" (Fly) | Fly served the port over HTTP/2, which can't do the WS upgrade | Use `handlers = ["tls"]` (not `["tls","http"]`) on the 18880 service in `fly.toml`, then redeploy. Delivery still works via polling even if WS fails. |
| Paper trade button not working (ntfy) | `BACKEND_PUBLIC_URL` not set or incorrect | Set `BACKEND_PUBLIC_URL` to the address the phone can reach (not `localhost` if on a different device) |
| Telegram messages arrive but buttons do nothing | Webhook not registered | Run the `setWebhook` curl command from [the Telegram setup section](#register-the-callback-webhook-one-time-cloud-only) |
| Telegram webhook returns 403 | Secret token mismatch | `TELEGRAM_WEBHOOK_SECRET` in `.env` / Fly secrets must match the `secret_token` passed to `setWebhook` |
| Email not sending | App Password wrong, 2FA off, or **Alert dispatch** toggle off | App Passwords require Google 2FA. Also check the **Alert dispatch** toggle at the top of the Notifications section — it gates email (ntfy/Telegram fire regardless). |

---

## Periodic reports — EoD digest & LLM summary

Two report endpoints fan out to **both** ntfy and Telegram (the Telegram side renders as a monospace `<pre>` block):

- **End-of-day digest** — `GET /reports/eod`. A deterministic summary of the day's economics, signals, and orders. Returns **502** if no channel is configured, so an external cron can't silently "succeed" while delivering nothing.
- **LLM summary** — `GET /reports/llm-summary?period=daily|weekly`. A natural-language summary written by the configured LLM. Every figure is computed in Python and passed to the model as structured data (**compute-then-narrate** — the model never does arithmetic); on any LLM/parse failure it falls back to the deterministic EoD digest, so a report always sends.

Both are meant to be triggered by an external scheduler (see BACKLOG item 8 — a Cloudflare Workers cron):

```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<your-backend>/reports/eod"
curl -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<your-backend>/reports/llm-summary?period=weekly"
```

**Getting better LLM summaries:** feed a compact structured slice (today's signals, closed trades, top movers) rather than raw dumps; keep the model at low temperature; ask for a fixed short JSON shape; and rely on the deterministic-digest fallback for robustness.
