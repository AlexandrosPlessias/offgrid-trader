/**
 * MarketSage — Cloudflare Workers Cron Trigger
 *
 * Handles three jobs:
 *   1. Start the Fly app at 8:30 AM ET Mon–Fri (via Fly Machines API)
 *   2. Send EoD report then stop the Fly app at 5:05 PM ET Mon–Fri
 *   3. Send weekly LLM summary at 5:25 PM ET Fridays
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
  // hourCycle "h23" (not hour12:false) — en-US defaults to h24, which renders
  // midnight as "24" and would skew the offset by a full day at 00:xx UTC.
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
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
  // Match on minute+hour only, never the whole expression. The five schedules have
  // distinct times, so the slot alone identifies the action — and matching this way
  // cannot be broken by how the day-of-week field happens to be rendered back to us.
  // Matching the full string previously meant any change in that field turned every
  // action into a silent no-op.
  const [minute, hour] = String(cron).trim().split(/\s+/);
  const slot = `${minute} ${hour}`;

  // Start uses dual twins — honour only the matching season to avoid double-starts.
  if (slot === "30 12") return offset === "-0400" ? "start" : "noop";
  if (slot === "30 13") return offset === "-0500" ? "start" : "noop";
  // Evening jobs use a single EDT cron — fire regardless of offset.
  // In EST they fire 1 h early but still after market close.
  if (slot === "5 21") return "eod";
  if (slot === "25 21") return "weekly";
  if (slot === "30 21") return "stop";
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
    console.log(`[cron] backend request ${method} ${path} attempt ${attempt}/${retries}`);
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
    if (attempt < retries) {
      console.log(`[cron] retrying ${method} ${path} in ${RETRY_DELAY_MS / 1000}s`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { ok: false, status: lastStatus, body: lastBody };
}

/** Call the Fly Machines API with the Fly API token. */
async function callFly(env, method, path, body) {
  const url = `${FLY_API}${path}`;
  console.log(`[cron] Fly API request ${method} ${path}`);
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
  if (!res.ok) {
    console.warn(`[cron] Fly API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return { ok: res.ok, status: res.status, body: text };
}

/** List all machines for the app. Returns an array of machine objects. */
async function listMachines(env) {
  const r = await callFly(env, "GET", `/apps/${env.FLY_APP}/machines`);
  if (!r.ok) {
    console.error(`[cron] listMachines failed ${r.status}: ${r.body.slice(0, 200)}`);
    return [];
  }
  try {
    const machines = JSON.parse(r.body);
    console.log(`[cron] listMachines ok: ${Array.isArray(machines) ? machines.length : 0} machine(s)`);
    return Array.isArray(machines) ? machines : [];
  } catch (err) {
    console.error(`[cron] listMachines JSON parse error: ${err}`);
    return [];
  }
}

/** Get the image ref from the latest successful release. */
async function getLatestImage(env) {
  const r = await callFly(env, "GET", `/apps/${env.FLY_APP}/releases?status=successful&limit=1`);
  if (!r.ok) return null;
  try {
    const releases = JSON.parse(r.body);
    const latest = Array.isArray(releases) ? releases[0] : releases;
    return latest?.image_ref ?? null;
  } catch {
    return null;
  }
}

/**
 * Most recent machine (including destroyed ones) to use as a creation template.
 *
 * A machine built from a hand-written config would be missing the volume mount,
 * the [[services]] port handlers, and the [env] block — it would boot but serve
 * no traffic and have no database. Cloning the last known-good config keeps all
 * of that intact; only the image is refreshed to the newest release.
 */
async function getMachineTemplate(env) {
  const r = await callFly(env, "GET", `/apps/${env.FLY_APP}/machines?include_deleted=true`);
  if (!r.ok) return null;
  try {
    const machines = JSON.parse(r.body);
    if (!Array.isArray(machines) || !machines.length) return null;
    const withConfig = machines.filter((m) => m?.config);
    if (!withConfig.length) return null;
    withConfig.sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));
    return withConfig[0];
  } catch (err) {
    console.error(`[cron] getMachineTemplate parse error: ${err}`);
    return null;
  }
}

/** Start all stopped machines, or recreate one from the last known config if none exist. */
async function startApp(env) {
  const machines = await listMachines(env);

  if (!machines.length) {
    console.warn("[cron] startApp: no live machines — recreating from last known config.");
    const template = await getMachineTemplate(env);
    if (!template) {
      console.error("[cron] startApp: no machine template found — run `fly deploy` manually.");
      return;
    }
    const config = { ...template.config, auto_destroy: false, restart: { policy: "no" } };
    const image = await getLatestImage(env);
    if (image) config.image = image;

    // Refuse to create a machine without the SQLite volume — a machine with no
    // mount silently loses every trade, signal and report the app has recorded.
    if (!Array.isArray(config.mounts) || !config.mounts.length) {
      console.error("[cron] startApp: template has no volume mount — aborting. Run `fly deploy`.");
      return;
    }
    console.log(
      `[cron] startApp: creating machine image=${config.image} region=${template.region} ` +
        `mounts=${config.mounts.length} services=${config.services?.length ?? 0}`
    );
    const r = await callFly(env, "POST", `/apps/${env.FLY_APP}/machines`, {
      region: template.region,
      config,
    });
    console.log(`[cron] startApp: machine create → ${r.status}: ${r.body.slice(0, 300)}`);
    return;
  }

  console.log(`[cron] startApp: starting ${machines.length} machine(s).`);
  for (const m of machines) {
    if (m.state === "started") {
      console.log(`[cron] machine ${m.id} already running — skipping.`);
      continue;
    }
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
  console.log(`[cron] stopApp: evaluating ${machines.length} machine(s).`);
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
    const startedAt = Date.now();

    console.log(`[cron] fired — schedule: "${cron}" · ET offset: ${offset} · resolved: ${action}`);
    console.log(
      `[cron] env check — BACKEND_URL=${Boolean(env.BACKEND_URL)} · ADMIN_TOKEN=${Boolean(env.ADMIN_TOKEN)} · FLY_API_TOKEN=${Boolean(env.FLY_API_TOKEN)} · FLY_APP=${env.FLY_APP ? "set" : "missing"}`
    );

    if (action === "noop") {
      console.log("[cron] Off-season twin cron — no-op.");
      return;
    }

    // ── Start app ─────────────────────────────────────────────────────────────
    if (action === "start") {
      console.log("[cron] Starting Fly app…");
      await startApp(env);
      console.log(`[cron] action start completed in ${Date.now() - startedAt}ms`);
      return;
    }

    // ── EoD reports (orders + frac, sequential so both notifications land) ──────
    if (action === "eod") {
      console.log("[cron] Sending EoD orders report…");
      const eodOrders = await callBackend(env, "GET", "/reports/eod/orders");
      console.log(`[cron] EoD orders result: ok=${eodOrders.ok} status=${eodOrders.status}`);
      console.log("[cron] Sending EoD frac report…");
      const eodFrac = await callBackend(env, "GET", "/reports/eod/frac");
      console.log(`[cron] EoD frac result: ok=${eodFrac.ok} status=${eodFrac.status}`);
      console.log(`[cron] action eod completed in ${Date.now() - startedAt}ms`);
      return;
    }

    // ── Stop app ──────────────────────────────────────────────────────────────
    if (action === "stop") {
      console.log("[cron] Stopping Fly app…");
      await stopApp(env);
      console.log(`[cron] action stop completed in ${Date.now() - startedAt}ms`);
      return;
    }

    // ── Weekly LLM summary ────────────────────────────────────────────────────
    if (action === "weekly") {
      console.log("[cron] Sending weekly orders report…");
      const weeklyOrders = await callBackend(env, "GET", "/reports/weekly/orders");
      console.log(`[cron] Weekly orders result: ok=${weeklyOrders.ok} status=${weeklyOrders.status}`);
      console.log("[cron] Sending weekly frac report…");
      const weeklyFrac = await callBackend(env, "GET", "/reports/weekly/frac");
      console.log(`[cron] Weekly frac result: ok=${weeklyFrac.ok} status=${weeklyFrac.status}`);
      console.log(`[cron] action weekly completed in ${Date.now() - startedAt}ms`);
      return;
    }
  },
};
