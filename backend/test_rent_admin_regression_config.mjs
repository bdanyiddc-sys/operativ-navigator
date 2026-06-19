/**
 * Rent admin config + UI regression test
 * node test_rent_admin_regression_config.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium;
for (const p of [
  path.join(__dirname, 'node_modules', 'playwright'),
  path.join(__dirname, '..', 'frontend', 'public', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
if (!chromium) { console.error('Playwright missing'); process.exit(2); }

const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';
const BUILD = 'rent-admin-regression-fix-config-ui-v1';
const OUT = path.join(__dirname, 'test-output', 'regression_config_ui.png');
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' – ' + detail : ''));
}

async function main() {
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || !health.ok) { console.error('Backend down'); process.exit(2); }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (_) { browser = await chromium.launch({ channel: 'msedge', headless: true }); }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(function () {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { r.unregister(); });
      });
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (keys) {
        keys.forEach(function (k) { caches.delete(k); });
      });
    }
  });
  const configLogs = [];
  page.on('console', function (msg) {
    if (msg.text().indexOf('[CONFIG SOURCE]') >= 0) configLogs.push(msg.text());
  });

  try {
    await page.goto(BASE + '/rent/admin?v=' + BUILD, { waitUntil: 'networkidle', timeout: 60000 });
    await page.selectOption('#admin-login-user', { label: 'Admin' });
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.locator('#admin-login-form button[type="submit"]').click();
    await page.waitForFunction(function (b) {
      var el = document.getElementById('admin-debug-banner');
      return el && el.textContent.indexOf(b) >= 0;
    }, BUILD, { timeout: 20000 });
    await page.waitForTimeout(1500);

    const banner = await page.locator('#admin-debug-banner').innerText();
    record('BUILD stamp', banner.indexOf(BUILD) >= 0, banner);

    const vehMatch = banner.match(/vehicles=(\d+)/);
    const drvMatch = banner.match(/drivers=(\d+)/);
    const veh = vehMatch ? parseInt(vehMatch[1], 10) : -1;
    const drv = drvMatch ? parseInt(drvMatch[1], 10) : -1;
    record('CONFIG vehicles=20', veh === 20, 'vehicles=' + veh);
    record('CONFIG drivers=20', drv === 20, 'drivers=' + drv);
    record('CONFIG status ok in banner', banner.indexOf('(ok)') >= 0, banner);

    record('CONFIG SOURCE log', configLogs.length > 0 && configLogs[0].indexOf('status=ok') >= 0,
      configLogs[0] ? configLogs[0].replace(/\n/g, ' ') : 'none');

    await page.locator('.leaflet-tooltip.map-label').first().click({ force: true });
    await page.waitForSelector('.leaflet-popup', { timeout: 8000 });
    await page.locator('.popup-open-form').click();
    await page.waitForTimeout(500);
    await page.locator('.form-tab[data-form-tab="resources"]').click();
    await page.waitForTimeout(400);

    const vehChips = await page.locator('#vehicleSuggestList .suggest-chip').count();
    const drvChips = await page.locator('#driverSuggestList .suggest-chip').count();
    const drvHint = await page.locator('#driverSuggestList .hint').count();
    record('Resources 20 vehicle chips', vehChips === 20, 'count=' + vehChips);
    record('Resources 20 driver chips', drvChips === 20, 'count=' + drvChips);
    record('No driver config error hint', drvHint === 0);

    const toolbarBox = await page.locator('.view-toggle').boundingBox();
    const toolbarBtns = await page.locator('.view-toggle .btn.secondary.sm').count();
    const btnTops = [];
    for (var i = 0; i < toolbarBtns; i++) {
      var box = await page.locator('.view-toggle .btn.secondary.sm').nth(i).boundingBox();
      if (box) btnTops.push(Math.round(box.y));
    }
    var uniqueTops = Array.from(new Set(btnTops));
    record('Toolbar single row (desktop 1440)', uniqueTops.length <= 1,
      'rows=' + uniqueTops.length + ' tops=' + btnTops.join(','));

    const headerBox = await page.locator('.work-header').boundingBox();
    const formBox = await page.locator('#bookingDetailHeader').boundingBox();
    record('Work header compact (<200px)', headerBox && headerBox.height < 200,
      'height=' + (headerBox ? Math.round(headerBox.height) : '?'));
    record('Booking header visible below toolbar', formBox && headerBox && formBox.y > headerBox.y,
      'formTop=' + (formBox ? Math.round(formBox.y) : '?'));

    await page.screenshot({ path: OUT, fullPage: false });
    record('Screenshot saved', fs.existsSync(OUT), OUT);

  } catch (err) {
    record('harness', false, err.message);
  } finally {
    await browser.close();
  }

  const ok = results.every(function (r) { return r.pass; });
  console.log('\n--- REGRESSION CONFIG/UI ---');
  console.log(results.filter(function (r) { return r.pass; }).length + '/' + results.length + ' PASS');
  process.exit(ok ? 0 : 1);
}

main();
