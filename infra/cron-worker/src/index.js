/**
 * MarketSage — Cloudflare Workers Cron Trigger
 *
 * Handles three jobs:
 *   1. Start the Fly app at 8:30 AM ET Mon–Fri (via Fly Machines API)
 *   2. Send EoD report then stop the Fly app at 5:05 PM ET Mon–Fri
 *   3. Send weekly LLM summary at 5:30 PM ET Fridays
 *
 * Scans are managed entirely by the in-process MonitorScheduler — this Worker
 * does not trigger individual scans.
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   ADMIN_TOKEN   — Bearer token for MarketSage admin middleware
 *   BACKEND_URL   — base URL, e.g. https://offgrid-trader.fly.dev (no trailing slash)
 *   FLY_API_TOKEN — Fly.io API token with read + write access to the app
 *   FLY_APP       — Fly app name, e.g. offgrid-trader
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const FLY_API = "https://api.machines.dev/v1";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10_000;

// ── DST resolver (mirrors app-power.yml logic) ────────────────────────────────

/**
 * Return the current Eastern UTC offset as a string: "-0400" (EDT) or "-0500" (EST).
 * Cloudflare Workers support Intl, so we can derive this precisely.
 */
function easternOffset() {
  // Compare UTC time vs ET time to derive the offset.
  const now = new Date();
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const utcH = now.getUTCHours();
  const etH = parseInt(etParts.find((p) => p.type === "hour").value, 10);
  // Difference (mod 24) gives us the offset magnitude.
  let diff = utcH - etH;
  if (diff < 0) diff += 24;
  return diff === 4 ? "-0400" : "-0500"; // EDT vs EST
}

/**
 * Given the cron string that fired and the current ET offset, decide what to do.
 * Returns: "start" | "stop" | "weekly" | "noop"
 *
 * Mirrors app-power.yml's resolve step exactly — only one of the two twins
 * for each action is honoured per Eastern offset.
 */
function resolveAction(cron, offset) {
  // Start uses dual twins — honour only the matching season to avoid double-starts.
  if (cron === "30 12 * * 1-5") return offset === "-0400" ? "start" : "noop";
  if (cron === "30 13 * * 1-5") return offset === "-0500" ? "start" : "noop";
  // Evening jobs use a single EDT cron — fire regardless of offset.
  // In EST they fire 1 h early but still after market close.
  if (cron === "5 21 * * 1-5")  return "eod";
  if (cron === "30 21 * * 1-5") return "stop";
  if (cron === "35 21 * * 5")   return "weekly";
  return "noop";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Call a backend endpoint with Bearer auth, retrying on non-2xx. */
async function callBackend(env, method, path, retries = MAX_RETRIES) {
  const url = `${env.BACKEND_URL}${path}`;
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${env.ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
      });
      lastStatus = res.status;
      lastBody = await res.text();
      if (res.ok) {
        console.log(`[cron] ${method} ${path} → ${lastStatus} (attempt ${attempt})`);
        return { ok: true, status: lastStatus, body: lastBody };
      }
      console.warn(`[cron] ${method} ${path} → ${lastStatus} attempt ${attempt}/${retries}: ${lastBody.slice(0, 200)}`);
    } catch (err) {
      console.error(`[cron] ${method} ${path} network error attempt ${attempt}/${retries}: ${err}`);
    }
    if (attempt < retries) await sleep(RETRY_DELAY_MS);
  }
  return { ok: false, status: lastStatus, body: lastBody };
}

/** Call the Fly Machines API with the Fly API token. */
async function callFly(env, method, path, body) {
  const url = `${FLY_API}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

/** List all machines for the app. Returns an array of machine objects. */
async function listMachines(env) {
  const r = await callFly(env, "GET", `/apps/${env.FLY_APP}/machines`);
  if (!r.ok) {
    console.error(`[cron] listMachines failed ${r.status}: ${r.body.slice(0, 200)}`);
    return [];
  }
  return JSON.parse(r.body);
}

/** Start all stopped machines. */
async function startApp(env) {
  const machines = await listMachines(env);
  if (!machines.length) {
    console.warn("[cron] startApp: no machines found.");
    return;
  }
  for (const m of machines) {
    console.log(`[cron] starting machine ${m.id} (state: ${m.state})`);
    const r = await callFly(env, "POST", `/apps/${env.FLY_APP}/machines/${m.id}/start`);
    console.log(`[cron] machine ${m.id} start → ${r.status}`);
  }
}

/** Stop all running machines. */
async function stopApp(env) {
  const machines = await listMachines(env);
  if (!machines.length) {
    console.warn("[cron] stopApp: no machines found.");
    return;
  }
  for (const m of machines) {
    if (m.state === "stopped") {
      console.log(`[cron] machine ${m.id} already stopped — skipping.`);
      continue;
    }
    console.log(`[cron] stopping machine ${m.id} (state: ${m.state})`);
    const r = await callFly(env, "POST", `/apps/${env.FLY_APP}/machines/${m.id}/stop`);
    console.log(`[cron] machine ${m.id} stop → ${r.status}`);
  }
}

// ── Scheduled handler ─────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron ?? "unknown";
    const offset = easternOffset();
    const action = resolveAction(cron, offset);

    console.log(`[cron] fired — schedule: "${cron}" · ET offset: ${offset} · resolved: ${action}`);

    if (action === "noop") {
      console.log("[cron] Off-season twin cron — no-op.");
      return;
    }

    // ── Start app ─────────────────────────────────────────────────────────────
    if (action === "start") {
      console.log("[cron] Starting Fly app…");
      await startApp(env);
      return;
    }

    // ── EoD report ────────────────────────────────────────────────────────────
    if (action === "eod") {
      console.log("[cron] Sending EoD report…");
      const eod = await callBackend(env, "GET", "/reports/eod");
      console.log(`[cron] EoD result: ok=${eod.ok} status=${eod.status}`);
      return;
    }

    // ── Stop app ──────────────────────────────────────────────────────────────
    if (action === "stop") {
      console.log("[cron] Stopping Fly app…");
      await stopApp(env);
      return;
    }

    // ── Weekly LLM summary ────────────────────────────────────────────────────
    if (action === "weekly") {
      console.log("[cron] Sending weekly LLM summary…");
      const r = await callBackend(env, "GET", "/reports/llm-summary?period=weekly");
      console.log(`[cron] Weekly summary result: ok=${r.ok} status=${r.status}`);
      return;
    }
  },
};
