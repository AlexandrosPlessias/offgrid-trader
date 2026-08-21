# Cloud LLM Providers

MarketSage supports **free cloud inference** as a drop-in alternative to running
Ollama locally. This lets you run the full analysis pipeline on any machine — no
GPU, no extra RAM, no 9 GB model download required.

> **Local Ollama is still the default** and works exactly as before. Cloud support
> is purely additive — switch at any time from the Settings page.

---

## Why cloud LLM?

| Situation | Recommendation |
|---|---|
| Machine has ≥ 12 GB VRAM / 16 GB RAM | Ollama locally (fastest, fully private) |
| Low-spec machine or laptop | Groq — free, fast, zero local overhead |
| Shared or headless server | Cloud provider via `.env` — no GPU driver setup |
| Testing without waiting for a model download | Cloud provider — starts instantly |

---

## Supported providers

| Provider | Sign-up URL | Free tier | Default model |
|---|---|---|---|
| **Groq Cloud** | https://console.groq.com | ~30 req/min · 6 000 req/day — **no card** | `llama-3.3-70b-versatile` |
| **Google Gemini** | https://aistudio.google.com | Flash-Lite 1 000 req/day · Flash 250 req/day — **no card** | `gemini-3.5-flash-lite` |
| **Mistral AI** | https://console.mistral.ai | ~1B tokens/month free — email signup | `mistral-small-latest` |
| **Custom endpoint** | Any OpenAI-compatible URL | — | Configurable |

At the default scan interval (15 min, 6-ticker watchlist) the app sends ~0.4 req/min.
All of the above free tiers have large headroom — you will not hit the limit in normal use.

---

## Getting a free API key

**Groq**
1. Go to **https://console.groq.com** and sign up (Google or GitHub SSO, no credit card).
2. In the left sidebar click **API Keys**.
3. Click **Create API Key**, give it a name (e.g. `marketsage`), and click **Submit**.
4. Copy the key — it starts with `gsk_`. You will only see it once.

**Gemini**
1. Go to **https://aistudio.google.com** and sign in with a Google account (no billing required).
2. Click **Get API key** → **Create API key**.
3. Copy the key — it starts with `AIza`.

**Mistral**
1. Go to **https://console.mistral.ai** and sign up (email, no credit card for the free tier).
2. Open **API Keys** and click **Create new key**.
3. Set a name and expiration, choose **Shared connectors only** for the connector access
   scope (the app only uses Chat Completions, not connectors), and create the key.
4. Copy the key immediately — it's shown only once.

---

## Configuring via the Settings page (recommended)

This is the easiest path — no file editing, no container restart needed.

1. Open the **Settings page** (⚙ gear icon in the top-right header) — sections are
   listed in a left-hand menu (Scheduler, Alerts, AI Provider, Data).
2. Click **AI Provider** in the left menu.
3. Select your provider from the dropdown (*Ollama*, *Groq*, *Gemini*, *Mistral*, or *Custom*).
   Switching providers clears the model/API key fields below so you can't
   accidentally save one provider's model against another.
4. Paste your API key in the **API Key** field.
5. Pick a **Model** from the dropdown suggestions or type any model ID —
   the first datalist entry is always “— type your own model —” as a hint.
6. For Groq/Gemini/Mistral, optionally set **Reasoning effort**
   (`none`/`low`/`medium`/`high`, default `none`) for models that support it.
7. Click **Save AI Provider settings** — a green “✓ Saved” confirms the write.

The change takes effect on the **next analysis run** — no restart needed. The key
is stored in the local SQLite database and is never returned by the API (the
Settings page only shows a ✓ indicator once a key is saved).

> **Use `.env` defaults:** for any non-custom provider, check “Use .env defaults”
> to fall back to whatever `.env` provides (model, base URL, API key) instead of a
> saved override — the fields display the actual resolved `.env` values while
> checked.

> **Switching back to Ollama:** select *Ollama (local)* in the dropdown and save.
> No other changes needed — Ollama containers must be running (`make infra`).

---

## Configuring via `.env` (before first start)

Edit your `.env` file:

```bash
# Groq example
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...

# Gemini example
# LLM_PROVIDER=gemini
# GEMINI_API_KEY=AIza...
# GEMINI_MODEL=gemini-3.5-flash-lite

# Mistral example
# LLM_PROVIDER=mistral
# MISTRAL_API_KEY=...
# MISTRAL_MODEL=mistral-small-latest

# Custom OpenAI-compatible endpoint
# LLM_PROVIDER=custom
# LLM_BASE_URL=https://your-host/v1
# LLM_API_KEY=...
# LLM_MODEL=your-model-name
```

Then start the stack:
```bash
make infra   # auto-detects LLM_PROVIDER, skips Ollama containers
make build   # or: make up (if already built)
```

> **`make infra` auto-skip:** when `LLM_PROVIDER` is anything other than `ollama`,
> the Ollama and `ollama-pull` containers are skipped automatically — no 9 GB download,
> no GPU memory used. Portainer still starts. Force Ollama on anyway with
> `bash infra/start-infra.sh --with-ollama`.

---

## Model reference

### Groq Cloud

| Model | Context | Speed | Notes |
|---|---|---|---|
| `llama-3.3-70b-versatile` | 128k | Very fast | Excellent analysis quality |
| `llama-3.1-8b-instant` | 128k | Fastest | Lighter; fewer reasoning steps |
| `qwen/qwen3.6-27b` | 131k | Fast | Reasoning model — supports `reasoning_effort` |

### Google Gemini

| Model | Notes |
|---|---|
| `gemini-3.5-flash-lite` | **Default**; fastest, cheapest tier |
| `gemini-3.5-flash` | More capable, still free-tier friendly |

> Gemini 3.x models cannot fully disable reasoning (`reasoning_effort=none` is
> rejected on Gemini 3 with a 400 error) — the app only sends `reasoning_effort`
> to Gemini when you pick a non-default value in Settings.

### Mistral AI

| Model | Notes |
|---|---|
| `mistral-small-latest` | **Default**; supports reasoning |
| `mistral-large-latest` | Larger, higher quality |

> Free-tier model availability changes over time. Check each provider's
> documentation for the current model list, or use `GET /settings/models` in
> this app once a provider/key is configured.

---

## Model tag in the UI

Every analysis shows which provider and model produced it:

- **Explorer → section 5 “AI reasoning”** — a small chip next to the header, e.g. `groq · llama-3.3-70b-versatile`
- **Dashboard → signal cards** — a model-tag bubble in the bottom-right corner, plus a “Model” column in the price grid

This is stored at analysis/signal time in the database (`analysis_log.llm_model`,
`signals.llm_model`), so the tag is accurate even if you switch providers between runs.

---

## Privacy

When using a cloud provider, each analysis sends the following to the provider's API:

- Ticker symbol
- Price, RSI, MACD, EMA, Bollinger Bands, Stochastic values (multiple timeframes)
- Recent news headlines (if `FINNHUB_API_KEY` is set)
- Balance sheet figures (assets, liabilities, equity)
- US macro data (FEDFUNDS rate, CPI, unemployment)

No personally identifiable information is sent. Review the provider's privacy policy
before use:
- Groq: https://groq.com/privacy-policy/
- Google Gemini: https://policies.google.com/privacy
- Mistral: https://mistral.ai/terms#privacy-policy

---

## Switching back to local Ollama

1. **Via Settings page:** select *Ollama (local)* in the AI Provider dropdown → Save.
2. **Via `.env`:** set `LLM_PROVIDER=ollama` (or remove the line entirely — `ollama` is the default) → `make up`.
3. Make sure the Ollama container is running: `make infra` (or `bash infra/start-infra.sh --with-ollama` if Portainer is already up).

---

## Related pages

- [Settings reference](settings.md) — full variable reference including all AI Provider fields
- [Architecture](architecture.md) — how the LLM call fits into the pipeline
