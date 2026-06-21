/**
 * Rent admin map stabil v1 – browser smoke test
 * node test_rent_admin_stabil.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

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
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' – ' + detail : ''));
}

async function login(page) {
  await page.goto(BASE + '/rent/admin', { waitUntil: 'networkidle', timeout: 60000 });
  if (await page.locator('#admin-login-gate').isVisible().catch(() => false)) {
    await page.selectOption('#admin-login-user', { label: 'Admin' });
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.locator('#admin-login-form button[type="submit"]').click();
    await page.waitForFunction(function () {
      var g = document.getElementById('admin-login-gate');
      return g && g.hidden;
    }, { timeout: 15000 });
  }
  await page.waitForFunction(function () {
    return document.getElementById('admin-debug-banner') &&
      document.getElementById('admin-debug-banner').textContent.indexOf('rent-admin-map-stabil-v1') >= 0;
  }, { timeout: 20000 });
}

async function main() {
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || !health.ok) { console.error('Backend down'); process.exit(2); }

  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (_) { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await login(page);
    await page.waitForSelector('.leaflet-tooltip.map-label', { timeout: 20000 });
    const markerCountBefore = await page.locator('.leaflet-tooltip.map-label').count();
    record('markers visible on load', markerCountBefore > 0, 'count=' + markerCountBefore);

    await page.locator('.leaflet-tooltip.map-label').first().click({ force: true });
    await page.waitForSelector('.leaflet-popup', { timeout: 5000 });
    const markerCountAfterPopup = await page.locator('.leaflet-tooltip.map-label').count();
    record('label click opens popup', await page.locator('.leaflet-popup').isVisible());
    record('other markers remain after popup', markerCountAfterPopup >= markerCountBefore,
      'before=' + markerCountBefore + ' after=' + markerCountAfterPopup);

    const popupText = await page.locator('.leaflet-popup-content').innerText();
    record('popup has Útvonaltervezés', popupText.indexOf('Útvonaltervezés') >= 0);

    await page.locator('.leaflet-popup-close-button').click();
    await page.waitForTimeout(300);
    record('popup close', !(await page.locator('.leaflet-popup').isVisible().catch(() => false)));

    record('refresh button exists', await page.locator('#btnRefreshRent').isVisible());
    record('auto refresh toggle exists', await page.locator('#btnAutoRefreshToggle').isVisible());
    record('data mgmt menu exists', await page.locator('#btnDataMgmt').isVisible());

    await page.locator('#btnRefreshRent').click();
    await page.waitForTimeout(1500);
    const afterRefresh = await page.locator('.leaflet-tooltip.map-label').count();
    record('refresh keeps markers', afterRefresh >= markerCountBefore, 'count=' + afterRefresh);

    await page.locator('#btnAutoRefreshToggle').click();
    const toggleText = await page.locator('#btnAutoRefreshToggle').innerText();
    record('auto refresh toggle', toggleText.indexOf('KI') >= 0, toggleText);

    await page.locator('.leaflet-tooltip.map-label').first().click({ force: true });
    await page.waitForSelector('.leaflet-popup');
    await page.locator('.popup-open-route').click();
    await page.waitForTimeout(500);
    const routesVisible = await page.locator('#module-routes').isVisible();
    record('útvonaltervezés gomb modult nyit', routesVisible);

  } catch (err) {
    record('test harness', false, err.message);
  } finally {
    await browser.close();
  }

  console.log('\n--- STABIL V1 TESZT ---');
  const ok = results.filter(function (r) { return r.pass; }).length;
  console.log(ok + '/' + results.length + ' PASS');
  process.exit(results.every(function (r) { return r.pass; }) ? 0 : 1);
}

main();
