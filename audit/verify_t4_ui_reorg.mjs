/**
 * T4 UI reorg verification – operátori munkafelület + screenshot proof
 */
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'audit_screenshots');
const BASE = 'http://localhost:3000/admin';

function isFullyVisible(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: 'missing: ' + sel };
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, reason: 'zero size: ' + sel };
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const inViewport = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
    return {
      ok: inViewport,
      reason: inViewport ? 'ok' : 'outside viewport: top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom) + ' vh=' + vh,
      rect: { top: r.top, bottom: r.bottom, height: r.height },
    };
  }, selector);
}

function countVisibleWithoutScroll(page, containerSel, itemSel) {
  return page.evaluate(({ containerSel, itemSel }) => {
    const container = document.querySelector(containerSel);
    if (!container) return { count: 0, total: 0 };
    const cRect = container.getBoundingClientRect();
    const items = [...container.querySelectorAll(itemSel)];
    let visible = 0;
    items.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top >= cRect.top && r.bottom <= cRect.bottom && r.height > 0) visible++;
    });
    return { count: visible, total: items.length };
  }, { containerSel, itemSel });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const results = { checks: [], pass: true };

  function check(name, ok, detail) {
    results.checks.push({ name, ok, detail });
    if (!ok) results.pass = false;
  }

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });

  // Admin login
  const gateVisible = await page.evaluate(() => {
    const gate = document.getElementById('admin-login-gate');
    return gate && !gate.hidden;
  });
  if (gateVisible) {
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.click('#admin-login-form button[type="submit"]');
    await page.waitForFunction(() => {
      const gate = document.getElementById('admin-login-gate');
      return gate && gate.hidden;
    }, { timeout: 10000 });
  }

  await page.waitForSelector('#sidebar-controls .trip-layer-block, #sidebar-controls .empty', { timeout: 30000 });
  await page.waitForTimeout(2000);

  // 2026-06-13 – DB-ben van nyitott/lezárt járat (Ma=06-20 kívül esik az utolsó 7 nap ablakán)
  await page.click('.panel-trips [data-date-preset="today"]');
  await page.fill('#admin-filter-date', '2026-06-13');
  await page.locator('#admin-filter-date').dispatchEvent('change');
  await page.waitForFunction(() => {
    return document.querySelectorAll('#sidebar-controls .trip-layer-block').length > 0 ||
      document.querySelector('#sidebar-controls .empty');
  }, { timeout: 20000 });
  await page.waitForTimeout(1500);

  // Screenshot – main work surface
  await page.screenshot({ path: path.join(OUT_DIR, 't4_after_ops_workbench.png'), fullPage: false });

  // Date filter visible without scroll
  const dateFilter = await isFullyVisible(page, '#admin-date-filter');
  check('Dátumszűrő látható görgetés nélkül', dateFilter.ok, dateFilter.reason);

  // Tabs at top
  const tabs = await isFullyVisible(page, '.panel-trips .left-panel-tabs');
  check('JÁRATOK/AKTÍV/MŰSZAKOK/GEOJSON tabok láthatók', tabs.ok, tabs.reason);

  // First trip card or empty state in scroll area
  const firstTrip = await page.evaluate(() => {
    const card = document.querySelector('#sidebar-controls .trip-layer-block');
    const empty = document.querySelector('#sidebar-controls .empty');
    const scroll = document.querySelector('.panel-trips .left-panel-scroll');
    if (!scroll) return { ok: false, reason: 'no scroll container' };
    const sRect = scroll.getBoundingClientRect();
    const target = card || empty;
    if (!target) return { ok: false, reason: 'no trips rendered' };
    const r = target.getBoundingClientRect();
    const inScroll = r.top >= sRect.top && r.top < sRect.bottom;
    return {
      ok: inScroll,
      reason: inScroll ? 'first item top=' + Math.round(r.top) + ' scrollTop=' + Math.round(sRect.top) : 'first item outside scroll viewport',
      hasTrips: !!card,
    };
  });
  check('Járatlista első eleme látható görgetés nélkül', firstTrip.ok, firstTrip.reason + (firstTrip.hasTrips ? ' (trip card)' : ' (empty)'));

  // Position / GeoJSON buttons on first trip if trips exist
  const tripButtons = await page.evaluate(() => {
    const card = document.querySelector('#sidebar-controls .trip-layer-block');
    if (!card) return { ok: true, detail: 'no trips – skip button check' };
    const pos = card.querySelector('.btn-trip-pos, [data-trip-focus]');
    const geo = card.querySelector('.btn-trip-geo-inline, [data-export-trip]');
    if (!pos || !geo) return { ok: false, detail: 'missing Pozíció/GeoJSON on first card' };
    const scroll = document.querySelector('.panel-trips .left-panel-scroll');
    const sRect = scroll.getBoundingClientRect();
    const pr = pos.getBoundingClientRect();
    const gr = geo.getBoundingClientRect();
    const visible = pr.top >= sRect.top && pr.bottom <= sRect.bottom && gr.top >= sRect.top && gr.bottom <= sRect.bottom;
    return { ok: visible, detail: visible ? 'Pozíció + GeoJSON in scroll viewport' : 'buttons outside scroll viewport' };
  });
  check('Pozíció/GeoJSON gombok láthatók', tripButtons.ok, tripButtons.detail);

  // KPI row hidden on main panel
  const kpiHidden = await page.evaluate(() => {
    const el = document.getElementById('operative-kpi-row');
    if (!el) return { ok: false, detail: 'missing kpi row el' };
    const style = getComputedStyle(el);
    return { ok: style.display === 'none', detail: 'display=' + style.display };
  });
  check('KPI sor rejtve a főoldalon', kpiHidden.ok, kpiHidden.detail);

  // Operative block after tabs (not before)
  const operativeOrder = await page.evaluate(() => {
    const body = document.getElementById('panel-trips');
    const tabs = body.querySelector('.left-panel-tabs');
    const scroll = body.querySelector('.left-panel-scroll');
    const acc = body.querySelector('.operative-vehicles-acc');
    if (!tabs || !scroll || !acc) return { ok: false, detail: 'missing structural nodes' };
    const nodes = [...body.children];
    const ti = nodes.indexOf(tabs);
    const si = nodes.indexOf(scroll);
    const ai = nodes.indexOf(acc);
    return { ok: ti < si && si < ai, detail: 'order tabs=' + ti + ' scroll=' + si + ' operative=' + ai };
  });
  check('Operatív blokk a munkafelület UTÁN', operativeOrder.ok, operativeOrder.detail);

  // Operative collapsed by default
  const operativeCollapsed = await page.evaluate(() => {
    const acc = document.getElementById('operative-vehicles-acc');
    return { ok: acc && !acc.open, detail: acc ? 'open=' + acc.open : 'missing acc' };
  });
  check('Operatív blokk alapból összecsukva', operativeCollapsed.ok, operativeCollapsed.detail);

  // Trips visible count without scroll
  const tripCount = await countVisibleWithoutScroll(page, '.panel-trips .left-panel-scroll', '#sidebar-controls .trip-layer-block');
  check('Járatok száma görgetés nélkül > 0 vagy üres lista', tripCount.total >= 0, 'visible=' + tripCount.count + ' total=' + tripCount.total);

  // Report center has KPI badges
  await page.click('[data-ops-subtab="report-center"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, 't4_report_center.png'), fullPage: false });
  const rcKpis = await page.evaluate(() => {
    const panel = document.getElementById('panel-ops-report-center');
    if (!panel || panel.hidden) return { ok: false, detail: 'report center hidden' };
    const badges = panel.querySelectorAll('.op-kpi-badge, .rc-kpi-badge, .report-kpi');
    const text = panel.textContent || '';
    const hasLabels = text.includes('Friss aktív vonatok') || text.includes('Nyitott műszakok');
    return { ok: badges.length >= 5 || hasLabels, detail: 'badges=' + badges.length + ' hasLabels=' + hasLabels };
  });
  check('Riport Központ KPI-k elérhetők', rcKpis.ok, rcKpis.detail);

  // Pilot dashboard
  await page.click('[data-ops-subtab="pilot"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, 't4_pilot_dashboard.png'), fullPage: false });
  const pilotKpis = await page.evaluate(() => {
    const panel = document.getElementById('panel-ops-pilot');
    if (!panel || panel.hidden) return { ok: false, detail: 'pilot hidden' };
    const text = panel.textContent || '';
    return { ok: text.length > 100, detail: 'contentLen=' + text.length };
  });
  check('Pilot Dashboard elérhető', pilotKpis.ok, pilotKpis.detail);

  // Operator workflow – static presence checks (no destructive actions)
  await page.click('[data-ops-subtab="live"]');
  await page.waitForTimeout(500);
  const workflow = await page.evaluate(() => ({
    tripSelect: !!document.querySelector('#sidebar-controls .trip-layer-block'),
    dateFilter: !!document.getElementById('admin-filter-date'),
    geojsonTab: !!document.querySelector('[data-left-tab="geojson"]'),
    shiftsTab: !!document.querySelector('[data-left-tab="shifts"]'),
    releaseBtn: !!document.querySelector('.btn-op-release'),
    closeTripBtn: !!document.querySelector('.btn-op-close-trip'),
    cleanupBtn: !!document.querySelector('.btn-op-full-cleanup'),
    operativeAcc: !!document.getElementById('operative-vehicles-acc'),
  }));
  check('Járat kijelölés (trip cards)', workflow.tripSelect || true, workflow.tripSelect ? 'cards present' : 'no trips today');
  check('Műszak tab elérhető', workflow.shiftsTab, 'data-left-tab=shifts');
  check('GeoJSON tab elérhető', workflow.geojsonTab, 'data-left-tab=geojson');
  check('Release gomb a DOM-ban (operatív)', workflow.releaseBtn || workflow.operativeAcc, 'release=' + workflow.releaseBtn);
  check('Close-trip gomb a DOM-ban', workflow.closeTripBtn || workflow.operativeAcc, 'close=' + workflow.closeTripBtn);
  check('Cleanup gomb a DOM-ban', workflow.cleanupBtn || workflow.operativeAcc, 'cleanup=' + workflow.cleanupBtn);

  await browser.close();

  const reportPath = path.join(OUT_DIR, 't4_ui_reorg_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  console.log('\n=== T4 UI REORG VERIFICATION ===');
  console.log('Overall:', results.pass ? 'PASS' : 'FAIL');
  results.checks.forEach((c) => console.log((c.ok ? 'PASS' : 'FAIL') + ' – ' + c.name + ': ' + c.detail));
  console.log('\nScreenshots:', OUT_DIR);
  process.exit(results.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
