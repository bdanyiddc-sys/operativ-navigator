/**
 * Right panel compact visual test
 * node test_right_panel_compact.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium;
for (const p of [
  path.join(__dirname, '..', 'node_modules', 'playwright'),
  path.join(__dirname, '..', '..', 'frontend', 'public', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
if (!chromium) { console.error('Playwright missing'); process.exit(2); }

const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';
const BUILD = 'rent-admin-right-panel-compact-v1';
const OUT_DIR = path.join(__dirname, '..', 'test-output', 'right_panel_compact');
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' – ' + detail : ''));
}

async function loginAndWait(page) {
  await page.goto(BASE + '/rent/admin?v=' + BUILD, { waitUntil: 'networkidle', timeout: 60000 });
  const gateVisible = await page.locator('#admin-login-gate:not([hidden])').isVisible().catch(function () { return false; });
  if (gateVisible) {
    await page.selectOption('#admin-login-user', { label: 'Admin' });
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.locator('#admin-login-form button[type="submit"]').click();
  }
  await page.waitForFunction(function (b) {
    var el = document.getElementById('admin-debug-banner');
    return el && el.textContent.indexOf(b) >= 0;
  }, BUILD, { timeout: 20000 });
  await page.waitForTimeout(1200);
}

async function measureAtViewport(page, label, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(400);

  const metrics = await page.evaluate(function () {
    var bookingsActive = document.querySelector('[data-main-module="bookings"]').classList.contains('is-active');
    var moduleVisible = !document.getElementById('module-bookings').hidden;
    var statsRow = document.querySelector('.stats-row');
    var statsRect = statsRow ? statsRow.getBoundingClientRect() : null;
    var statsOneRow = statsRect ? statsRect.height <= 40 : false;
    var filterBlock = document.querySelector('.filters-compact');
    var filterRect = filterBlock ? filterBlock.getBoundingClientRect() : null;
    var list = document.getElementById('bookingList');
    var listRect = list ? list.getBoundingClientRect() : null;
    var items = list ? list.querySelectorAll('.list-item') : [];
    var visibleItems = 0;
    if (listRect) {
      items.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom > listRect.top && r.top < listRect.bottom) visibleItems++;
      });
    }
    var delBtn = list ? list.querySelector('.list-del-btn') : null;
    var delPos = null;
    if (delBtn) {
      var dr = delBtn.getBoundingClientRect();
      var ir = delBtn.closest('.list-item').getBoundingClientRect();
      delPos = {
        topRight: dr.right >= ir.right - 8 && dr.top <= ir.top + 14,
        inItem: dr.top >= ir.top && dr.bottom <= ir.bottom + 2
      };
    }
    var listTop = listRect ? listRect.top : 0;
    return {
      bookingsActive: bookingsActive,
      moduleVisible: moduleVisible,
      statsOneRow: statsOneRow,
      statsHeight: statsRect ? Math.round(statsRect.height) : 0,
      filterHeight: filterRect ? Math.round(filterRect.height) : 0,
      visibleItems: visibleItems,
      totalItems: items.length,
      listTop: Math.round(listTop),
      delTopRight: delPos ? delPos.topRight : false
    };
  });

  const shot = path.join(OUT_DIR, label + '_' + w + 'x' + h + '.png');
  await page.screenshot({ path: shot, fullPage: false });

  record(label + ' bookings tab active @' + w + 'x' + h, metrics.bookingsActive && metrics.moduleVisible);
  record(label + ' stats one row @' + w + 'x' + h, metrics.statsOneRow, 'h=' + metrics.statsHeight);
  record(label + ' delete top-right @' + w + 'x' + h, metrics.delTopRight || metrics.totalItems === 0, 'items=' + metrics.totalItems);
  record(label + ' visible list items @' + w + 'x' + h, w >= 1900 ? metrics.visibleItems >= 5 : metrics.visibleItems >= 3,
    'visible=' + metrics.visibleItems + ' total=' + metrics.totalItems + ' listTop=' + metrics.listTop + ' filterH=' + metrics.filterHeight);
  record(label + ' screenshot @' + w + 'x' + h, fs.existsSync(shot), shot);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (_) { browser = await chromium.launch({ channel: 'msedge', headless: true }); }

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(function () {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (r) { r.forEach(function (x) { x.unregister(); }); });
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (k) { k.forEach(function (x) { caches.delete(x); }); });
    }
  });

  await loginAndWait(page);
  await measureAtViewport(page, 'after', 1366, 768);
  await measureAtViewport(page, 'after', 1920, 1080);

  await browser.close();

  const ok = results.every(function (r) { return r.pass; });
  console.log('\n--- RIGHT PANEL COMPACT ---');
  console.log(results.filter(function (r) { return r.pass; }).length + '/' + results.length + ' PASS');
  process.exit(ok ? 0 : 1);
}

main().catch(function (e) { console.error(e); process.exit(2); });
