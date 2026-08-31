/**
 * MarketSage — screenshot capture script
 *
 * Captures all app views at 1440×900 (desktop) into this directory.
 * Requires the full stack to be running (docker compose up -d).
 *
 * Usage (from repo root or from docs/screenshots/):
 *   node docs/screenshots/capture.mjs
 *
 * If playwright is not installed globally, install it first:
 *   cd docs/screenshots && npm init -y && npm install playwright
 *   node capture.mjs
 *
 * Outputs
 * -------
 * Overview views (4):
 *   01-dashboard.png
 *   02-explorer.png
 *   03-learn.png
 *   04-learn-expanded.png
 *   05-settings.png
 *
 * Explorer — per-section (10), requires a saved analysis in history:
 *   explorer-01-pipeline.png
 *   explorer-02-price.png
 *   explorer-03-company.png
 *   explorer-04-chart.png
 *   explorer-05-indicators.png
 *   explorer-06-news.png
 *   explorer-07-balance-sheet.png
 *   explorer-08-macro.png
 *   explorer-09-ai-reasoning.png
 *   explorer-10-signals.png
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT   = __dir;                          // save next to this script
const BASE  = 'http://localhost:5174';
const VP    = { width: 1440, height: 900 };

// ─── helpers ────────────────────────────────────────────────────────────────

async function shot(page, name, fn) {
  await fn();
  await page.waitForTimeout(900);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log('✓', name);
}

/** Scroll to an element (by CSS selector or Locator) then screenshot. */
async function shotAt(page, name, locator) {
  const el = typeof locator === 'string' ? page.locator(locator).first() : locator;
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log('✓', name);
}

/** Find the closest ancestor .explorer-section wrapping a section-label. */
function sectionOf(page, labelText) {
  return page
    .locator('.section-label')
    .filter({ hasText: labelText })
    .first()
    .locator('xpath=ancestor::*[contains(@class,"explorer-section")][1]');
}

// ─── main ────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const ctx     = await browser.newContext({ viewport: VP });
const page    = await ctx.newPage();

// ── 1. Overview shots ────────────────────────────────────────────────────────

await shot(page, '01-dashboard.png', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
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
  // expand the first (Pipeline) section
  await page.locator('.edu-summary').first().click();
  await page.waitForTimeout(700);
});

await shot(page, '05-settings.png', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(700);
});

// ── 2. Explorer with a saved analysis loaded ─────────────────────────────────

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('text=Explorer');
await page.waitForTimeout(600);

// Expand "Analysis History" collapsible panel (click the header to toggle)
await page.locator('.history-panel-header').first().click();
await page.waitForTimeout(900);

// Wait for the history table to appear, then click first "Open in Explorer" button
let loaded = false;
try {
  await page.locator('.btn-open-history').first().waitFor({ timeout: 5000 });
  await page.locator('.btn-open-history').first().click();
  await page.waitForTimeout(2500);
  // confirm the pipeline section is now visible
  await page.locator('.section-label', { hasText: 'Pipeline' }).first().waitFor({ timeout: 8000 });
  loaded = true;
} catch (e) {
  console.warn('⚠  No saved analysis rows found — skipping per-section shots.');
  console.warn('   Run the scheduler or POST /analyze once to create saved analyses.');
  console.warn('   Detail:', e.message?.slice(0, 120));
}

if (loaded) {
  // Expand ALL collapsible explorer sections so they are all visible
  for (const details of await page.locator('details.explorer-section, details.explorer-collapsible').all()) {
    const isOpen = await details.getAttribute('open');
    if (isOpen === null) await details.click();   // null = closed attribute absent
  }
  await page.waitForTimeout(600);

  // Per-section viewport screenshots
  await shotAt(page, 'explorer-01-pipeline.png',     sectionOf(page, 'Pipeline walkthrough'));
  await shotAt(page, 'explorer-02-price.png',        sectionOf(page, 'Price snapshot'));
  await shotAt(page, 'explorer-03-company.png',      sectionOf(page, 'Company overview'));
  await shotAt(page, 'explorer-04-chart.png',        sectionOf(page, 'Historical chart'));
  await shotAt(page, 'explorer-05-indicators.png',   sectionOf(page, 'Technical indicators'));
  await shotAt(page, 'explorer-06-news.png',         sectionOf(page, 'Recent headlines'));
  await shotAt(page, 'explorer-07-balance-sheet.png', sectionOf(page, 'Financial health'));
  await shotAt(page, 'explorer-08-macro.png',
    sectionOf(page, 'US macro context'));
  await shotAt(page, 'explorer-09-ai-reasoning.png', sectionOf(page, 'AI reasoning'));
  await shotAt(page, 'explorer-10-signals.png',      sectionOf(page, 'Signals detected'));
}

// ── 3. Backtesting page ──────────────────────────────────────────────────────

await shot(page, '06-backtesting.png', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('text=Backtesting');
  await page.waitForTimeout(1200);
});

// If there are past runs in the list, click one to show the results view
await shot(page, '07-backtesting-results.png', async () => {
  // Try clicking the first past-run row to open it; fall back to params view
  try {
    await page.locator('.bt-run-row, .run-row, tbody tr').first().waitFor({ timeout: 4000 });
    await page.locator('.bt-run-row, .run-row, tbody tr').first().click();
    await page.waitForTimeout(1500);
  } catch {
    console.warn('⚠  No past backtest runs found — keeping parameter view for 07.');
  }
});

// ── 4. Settings — AI Provider ─────────────────────────────────────────────────

await shot(page, '08-settings-ai-provider.png', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(600);
  // Click the AI Provider menu item
  try {
    await page.locator('text=AI Provider').first().click();
    await page.waitForTimeout(800);
  } catch { /* already on Settings, might already show AI Provider */ }
});

// ── 5. Settings — AI Usage ────────────────────────────────────────────────────

await shot(page, '09-settings-ai-usage.png', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(600);
  try {
    await page.locator('text=AI Usage').first().click();
    await page.waitForTimeout(1200); // wait for charts to render
  } catch { console.warn('⚠  AI Usage nav item not found'); }
});

// Scroll to show the quota/limits section
await shot(page, '10-settings-ai-usage-quota.png', async () => {
  try {
    const quotaBox = page.locator('.usage-quota-box').first();
    await quotaBox.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  } catch { console.warn('⚠  usage-quota-box not found'); }
});

// ── 6. Dashboard — Paper Orders sidebar + live watchlist ─────────────────────

await shot(page, '11-dashboard-paper-orders.png', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // let price table load
  // Ensure the Paper Orders panel is expanded (click the toggle if collapsed)
  try {
    const panelBtn = page.locator('.paper-panel-toggle, [class*="paper-panel"]').first();
    const isVisible = await panelBtn.isVisible().catch(() => false);
    if (isVisible) await panelBtn.click();
    await page.waitForTimeout(800);
  } catch { /* panel may already be open */ }
});

// ── 7. Settings — Paper Trading ───────────────────────────────────────────────

await shot(page, '12-settings-paper-trading.png', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.tool-btn').last().click();
  await page.waitForTimeout(600);
  try {
    await page.locator('text=Paper Trading').first().click();
    await page.waitForTimeout(800);
  } catch { console.warn('⚠  Paper Trading nav item not found'); }
});

await browser.close();
console.log('\nAll screenshots saved to:', OUT);
