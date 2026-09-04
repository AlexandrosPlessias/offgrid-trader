/**
 * MarketSage — screenshot capture script
 *
 * Captures all app views at 1440×900 (desktop) into this directory.
 *
 * Can target the local dev server OR the live production domain:
 *
 *   # Local (default — docker compose up -d must be running):
 *   node capture.mjs
 *
 *   # Live production domain:
 *   SCREENSHOT_BASE_URL=https://offgrid-trader.vercel.app \
 *   ADMIN_TOKEN=<your-token> \
 *   node capture.mjs
 *
 * If playwright is not installed:
 *   cd docs/screenshots && npm install
 *   npx playwright install chromium
 *
 * Outputs
 * -------
 * Overview views:
 *   01-dashboard.png
 *   02-explorer.png
 *   03-learn.png
 *   04-learn-expanded.png
 *   05-settings.png
 *   13-trading-page.png        ← NEW: Trading tab (account + charts)
 *   14-trading-orders.png      ← NEW: Orders table (expanded row)
 *   15-signal-card-order.png   ← NEW: Signal card with order status badge
 *
 * Explorer — per-section (10), requires a saved analysis in history:
 *   explorer-01-pipeline.png  …  explorer-10-signals.png
 *
 * Other:
 *   06-backtesting.png  07-backtesting-results.png
 *   08-settings-ai-provider.png  09-settings-ai-usage.png
 *   10-settings-ai-usage-quota.png
 *   11-dashboard-paper-orders.png  12-settings-paper-trading.png
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT   = __dir;
const BASE  = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:5174';
const TOKEN = process.env.ADMIN_TOKEN ?? '';
const VP    = { width: 1440, height: 900 };

console.log(`📸 Capturing screenshots from: ${BASE}`);
if (TOKEN) console.log('🔑 ADMIN_TOKEN set — will authenticate via login screen');

// ─── helpers ────────────────────────────────────────────────────────────────

async function shot(page, name, fn) {
  await fn();
  await page.waitForTimeout(900);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log('✓', name);
}

async function shotAt(page, name, locator) {
  const el = typeof locator === 'string' ? page.locator(locator).first() : locator;
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log('✓', name);
}

function sectionOf(page, labelText) {
  return page
    .locator('.section-label')
    .filter({ hasText: labelText })
    .first()
    .locator('xpath=ancestor::*[contains(@class,"explorer-section")][1]');
}

/** Log in via the login screen if ADMIN_TOKEN is set. */
async function login(page) {
  if (!TOKEN) return;
  // Wait for the password input that appears on the login screen
  const input = page.locator('input[type="password"], input[placeholder*="password" i], input[placeholder*="token" i], input[placeholder*="Password"]').first();
  try {
    await input.waitFor({ timeout: 5000 });
    await input.fill(TOKEN);
    // Click the AUTH / Sign in button
    const btn = page.locator('button:has-text("AUTH"), button:has-text("Sign in"), button[type="submit"]').first();
    await btn.click();
    // Wait for the main app to load (header nav appears)
    await page.locator('.header-nav').waitFor({ timeout: 10000 });
    console.log('🔑 Logged in');
  } catch {
    // Already logged in or no login screen
  }
}

/** Navigate to a page and handle login if needed. */
async function goto(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await login(page);
}

// ─── main ────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const ctx     = await browser.newContext({ viewport: VP });
const page    = await ctx.newPage();

// ── 1. Overview shots ────────────────────────────────────────────────────────

await shot(page, '01-dashboard.png', async () => {
  await goto(page, BASE);
  await page.waitForTimeout(1500);
});

await shot(page, '02-explorer.png', async () => {
  await page.click('text=Explorer');
  await page.waitForTimeout(500);
});

await shot(page, '03-learn.png', async () => {
  await page.click('text=Learn');
  await page.waitForTimeout(500);
});

await shot(page, '04-learn-expanded.png', async () => {
  await page.locator('.edu-summary').first().click();
  await page.waitForTimeout(700);
});

await shot(page, '05-settings.png', async () => {
  await goto(page, BASE);
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(700);
});

// ── 2. Trading page ──────────────────────────────────────────────────────────

await shot(page, '13-trading-page.png', async () => {
  await goto(page, BASE);
  await page.click('text=Trading');
  // Wait for the account metrics tiles to appear (confirms data loaded)
  try {
    await page.locator('text=Portfolio Value, text=Buying Power').first().waitFor({ timeout: 8000 });
  } catch {}
  await page.waitForTimeout(3000); // let charts render
});

// Scroll to the orders table and expand the first row
await shot(page, '14-trading-orders.png', async () => {
  // Still on Trading page — scroll to Orders section
  try {
    const ordersHeading = page.locator('text=Orders').first();
    await ordersHeading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    // Try to find and click the first expandable order row (has ▸ toggle)
    const firstToggle = page.locator('td:has-text("▸")').first();
    const hasToggle = await firstToggle.isVisible().catch(() => false);
    if (hasToggle) {
      await firstToggle.locator('xpath=ancestor::tr[1]').click();
      await page.waitForTimeout(1000);
    } else {
      // fallback: click first tbody tr in the orders table
      const firstRow = page.locator('tbody tr').first();
      await firstRow.waitFor({ timeout: 5000 });
      await firstRow.click();
      await page.waitForTimeout(800);
    }
  } catch { console.warn('⚠  No order rows found — screenshotting current view'); }
});

// ── 3. Signal card with order status ────────────────────────────────────────

await shot(page, '15-signal-card-order.png', async () => {
  await goto(page, BASE);
  await page.waitForTimeout(2500);
  // Expand the Signals section if it is collapsed
  try {
    const signalsSummary = page.locator('.signals-collapsible summary, details:has(.signal-card) summary').first();
    const isOpen = await page.locator('.signal-card').first().isVisible().catch(() => false);
    if (!isOpen) await signalsSummary.click();
    await page.waitForTimeout(800);
    const card = page.locator('.signal-card').first();
    await card.waitFor({ timeout: 5000 });
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
  } catch { console.warn('⚠  No signal cards found — screenshotting current view'); }
});

// ── 4. Explorer with a saved analysis loaded ─────────────────────────────────

await goto(page, BASE);
await page.click('text=Explorer');
await page.waitForTimeout(600);

await page.locator('.history-panel-header').first().click();
await page.waitForTimeout(900);

let loaded = false;
try {
  await page.locator('.btn-open-history').first().waitFor({ timeout: 5000 });
  await page.locator('.btn-open-history').first().click();
  await page.waitForTimeout(2500);
  await page.locator('.section-label', { hasText: 'Pipeline' }).first().waitFor({ timeout: 8000 });
  loaded = true;
} catch (e) {
  console.warn('⚠  No saved analysis rows found — skipping per-section shots.');
  console.warn('   Detail:', e.message?.slice(0, 120));
}

if (loaded) {
  for (const details of await page.locator('details.explorer-section, details.explorer-collapsible').all()) {
    const isOpen = await details.getAttribute('open');
    if (isOpen === null) await details.click();
  }
  await page.waitForTimeout(600);

  await shotAt(page, 'explorer-01-pipeline.png',      sectionOf(page, 'Pipeline walkthrough'));
  await shotAt(page, 'explorer-02-price.png',         sectionOf(page, 'Price snapshot'));
  await shotAt(page, 'explorer-03-company.png',       sectionOf(page, 'Company overview'));
  await shotAt(page, 'explorer-04-chart.png',         sectionOf(page, 'Historical chart'));
  await shotAt(page, 'explorer-05-indicators.png',    sectionOf(page, 'Technical indicators'));
  await shotAt(page, 'explorer-06-news.png',          sectionOf(page, 'Recent headlines'));
  await shotAt(page, 'explorer-07-balance-sheet.png', sectionOf(page, 'Financial health'));
  await shotAt(page, 'explorer-08-macro.png',         sectionOf(page, 'US macro context'));
  await shotAt(page, 'explorer-09-ai-reasoning.png',  sectionOf(page, 'AI reasoning'));
  await shotAt(page, 'explorer-10-signals.png',       sectionOf(page, 'Signals detected'));
}

// ── 5. Backtesting ────────────────────────────────────────────────────────────

await shot(page, '06-backtesting.png', async () => {
  await goto(page, BASE);
  await page.click('text=Backtesting');
  await page.waitForTimeout(1200);
});

await shot(page, '07-backtesting-results.png', async () => {
  try {
    await page.locator('.bt-run-row, .run-row, tbody tr').first().waitFor({ timeout: 4000 });
    await page.locator('.bt-run-row, .run-row, tbody tr').first().click();
    await page.waitForTimeout(1500);
  } catch { console.warn('⚠  No past backtest runs found'); }
});

// ── 6. Settings ───────────────────────────────────────────────────────────────

await shot(page, '08-settings-ai-provider.png', async () => {
  await goto(page, BASE);
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(600);
  try { await page.locator('text=AI Provider').first().click(); await page.waitForTimeout(800); } catch {}
});

await shot(page, '09-settings-ai-usage.png', async () => {
  await goto(page, BASE);
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(600);
  try { await page.locator('text=AI Usage').first().click(); await page.waitForTimeout(1200); } catch { console.warn('⚠  AI Usage not found'); }
});

await shot(page, '10-settings-ai-usage-quota.png', async () => {
  try { await page.locator('.usage-quota-box').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(500); } catch {}
});

await shot(page, '11-dashboard-paper-orders.png', async () => {
  await goto(page, BASE);
  await page.waitForTimeout(1500);
  try {
    const panelBtn = page.locator('.paper-panel-toggle, [class*="paper-panel"]').first();
    if (await panelBtn.isVisible().catch(() => false)) await panelBtn.click();
    await page.waitForTimeout(800);
  } catch {}
});

await shot(page, '12-settings-paper-trading.png', async () => {
  await goto(page, BASE);
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(600);
  try { await page.locator('text=Paper Trading').first().click(); await page.waitForTimeout(800); } catch { console.warn('⚠  Paper Trading nav item not found'); }
});

await browser.close();
console.log('\n✅ All screenshots saved to:', OUT);
console.log('\nTo run against production:');
console.log('  SCREENSHOT_BASE_URL=https://offgrid-trader.vercel.app ADMIN_TOKEN=<token> node capture.mjs');
