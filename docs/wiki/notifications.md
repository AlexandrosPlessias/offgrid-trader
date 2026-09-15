# Notifications

MarketSage sends **batched push alerts** at the end of each scan cycle — one
message covering every signal detected in that run, with action buttons for
placing paper trades directly from your phone.

Three channels are available. All are off by default and independently
enabled:

| Channel | Delivery | Credentials | Privacy |
|---|---|---|---|
| **ntfy** (recommended) | Push notification (mobile + browser) | None — topic name is the only secret | Self-hosted on your own infrastructure |
| **Telegram** | Bot message with inline buttons | BotFather token + chat ID | Sent via Telegram's servers |
| **Email** | Gmail SMTP | App Password | Sent via Gmail |

> ⚠️ **Not financial advice.** Signals are for educational/research purposes only.
> Action buttons place orders on your **paper trading** account, not real money.

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

### 3. Enable via the Settings page

1. Open **Settings** (⚙ gear icon in the header) → scroll to **Notifications**.
2. Toggle **ntfy** on.
3. Paste your topic name, confirm the server URL matches your deployment.
4. Click **Save**.

Changes take effect immediately — no restart needed.

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

Each scan-cycle summary looks like this on your phone:

```
Title:  MarketSage — 3 signals  🕐 14:30 ET
Body:
  📈 AAPL  BUY   78% — RSI oversold + MACD cross
  📉 TSLA  SHORT 71% — Volume spike + AI
  ⚖  NVDA  HOLD  52% — below floor

  [Paper AAPL BUY]   [Paper TSLA SELL]
```

Tapping a **Paper** button calls `POST /paper/orders` on your backend — the
same endpoint as the UI. The order goes through the identical Alpaca submission
and validation path; no shortcuts.

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

### 4. Inline keyboard buttons (paper trade from phone)

When a Telegram notification arrives the message includes an inline keyboard
with one button per actionable signal:

```
📈 AAPL BUY 78%
[📄 Paper AAPL BUY]

📉 TSLA SHORT 71%
[📄 Paper TSLA SELL]
```

Tapping a button triggers `POST /notifications/telegram/callback` → which
calls `POST /paper/orders` internally. Same validation, same Alpaca path as
the UI.

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

## Email — Gmail SMTP

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

### Global enable switch

Email can be suspended without touching `EMAIL_ENABLED` — useful during local
testing when you don't want alerts to fire:

```bash
curl -X POST http://localhost:8010/settings/alerts \
     -H "Content-Type: application/json" \
     -d '{"enabled": false}'
```

Telegram and ntfy are unaffected by this switch; they use their own enable
flags.

---

## API reference

### GET /settings/notifications

Returns the current effective ntfy config.

```bash
curl http://localhost:8010/settings/notifications
```

```json
{
  "ntfy_enabled": true,
  "ntfy_topic_set": true,
  "ntfy_server": "http://ntfy:80",
  "ntfy_configured": true
}
```

### POST /settings/notifications/ntfy

Update ntfy settings at runtime (no restart needed). All fields optional.

```bash
curl -X POST http://localhost:8010/settings/notifications/ntfy \
     -H "Content-Type: application/json" \
     -d '{
       "enabled": true,
       "topic": "a1b2c3d4e5f6a1b2c3d4e5f6",
       "server": "http://ntfy:80"
     }'
```

### POST /notifications/telegram/callback

Telegram webhook endpoint — called automatically by Telegram when the user taps
an inline button. Register it via `setWebhook` (see [Telegram setup](#register-the-callback-webhook-one-time-cloud-only)).

---

## Verifying notifications work

### ntfy — quick test

```bash
# Enable ntfy temporarily:
curl -X POST http://localhost:8010/settings/notifications/ntfy \
     -H "Content-Type: application/json" \
     -d '{"enabled": true, "topic": "my-test-topic"}'

# Trigger an on-demand analysis (signal fires the notification):
curl -X POST http://localhost:8010/analyze \
     -H "Content-Type: application/json" \
     -d '{"ticker": "AAPL"}'
```

Open `http://localhost:18880/my-test-topic` in a browser to see the message.

### Telegram — quick test

After configuring the bot token and chat ID, trigger an analysis as above.
The message should appear in your Telegram chat within a few seconds.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| ntfy notification not received | App subscribed to wrong server or topic | Confirm the URL in the app matches `NTFY_SERVER`/`NTFY_TOPIC`; subscribe to `http://<host-ip>:18880/<topic>`, not ntfy.sh |
| ntfy container not starting | Port 18880 already in use | `ss -tlnp \| grep 18880` — stop the conflicting process or change the host port in `docker-compose.infra.yml` |
| Paper trade button not working (ntfy) | `BACKEND_PUBLIC_URL` not set or incorrect | Set `BACKEND_PUBLIC_URL` to the address the phone can reach (not `localhost` if on a different device) |
| Telegram messages arrive but buttons do nothing | Webhook not registered | Run the `setWebhook` curl command from [the Telegram setup section](#register-the-callback-webhook-one-time-cloud-only) |
| Telegram webhook returns 403 | Secret token mismatch | `TELEGRAM_WEBHOOK_SECRET` in `.env` / Fly secrets must match the `secret_token` passed to `setWebhook` |
| No alerts at all | Global alert switch off | `curl http://localhost:8010/settings` and check `alerts_enabled`; re-enable via `POST /settings/alerts` |
| Email not sending | App Password wrong or 2FA not set up | App Passwords require Google 2FA. Re-create at https://myaccount.google.com/apppasswords |
