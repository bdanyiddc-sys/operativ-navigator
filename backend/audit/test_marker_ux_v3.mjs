/**
 * Marker UX V3 – browser integration test (Playwright)
 * Run: node test_marker_ux_v3.mjs
 * Requires: backend on :3000, playwright in backend/node_modules or frontend/public/node_modules
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let chromium;
const candidates = [
  path.join(__dirname, '..', 'node_modules', 'playwright'),
  path.join(__dirname, '..', '..', 'frontend', 'public', 'node_modules', 'playwright'),
];
for (const p of candidates) {
  try {
    chromium = require(p).chromium;
    break;
  } catch (_) { /* try next */ }
}
if (!chromium) {
  console.error('Playwright not found. Install: cd backend && npm install -D playwright');
  process.exit(2);
}

const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';
const ADMIN_URL = BASE + '/rent/admin';
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' – ' + detail : ''));
}

async function fetchJson(url, opts) {
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

async function main() {
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || !health.ok) {
    console.error('Backend not running at ' + BASE);
    process.exit(2);
  }

  const { data: listData } = await fetchJson(BASE + '/api/rent/inquiries');
  const inquiries = (listData && listData.inquiries) || [];
  const target = inquiries.find(function (b) {
    return b && b.id && b.lat != null && b.lng != null;
  });
  if (!target) {
    console.error('No inquiry with lat/lng for testing');
    process.exit(2);
  }

  const testPrice = 180000;
  await fetchJson(BASE + '/api/rent/inquiries/' + encodeURIComponent(target.id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: testPrice }),
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (launchErr) {
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
    } catch (_) {
      try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
      } catch (e2) {
        console.error('Browser launch failed:', launchErr.message);
        throw e2;
      }
    }
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const gate = page.locator('#admin-login-gate');
    if (await gate.isVisible().catch(() => false)) {
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
        document.getElementById('admin-debug-banner').textContent.indexOf('marker-ux-v3') >= 0;
    }, { timeout: 20000 });

    await page.waitForSelector('.leaflet-tooltip.map-label', { timeout: 20000 });
    await page.waitForTimeout(1500);

    const label = page.locator('.leaflet-tooltip.map-label').first();
    await label.click({ force: true });
    await page.waitForSelector('.leaflet-popup', { timeout: 5000 });
    const popupVisible = await page.locator('.leaflet-popup').isVisible();
    record('label click', popupVisible, popupVisible ? 'popup opened' : 'no popup');

    const popupOpen = popupVisible;
    record('popup open', popupOpen);

    const popupText = await page.locator('.leaflet-popup-content').innerText();
    record('ár megjelenik', popupText.indexOf('Ár:') >= 0 && popupText.indexOf('180') >= 0, popupText.match(/Ár:[^\n]+/)?.[0] || '');

    if (await page.locator('.leaflet-popup-close-button').count()) {
      await page.locator('.leaflet-popup-close-button').click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(300);

    const markerClickOk = await page.evaluate(function () {
      var pane = document.querySelector('.leaflet-overlay-pane');
      if (!pane) return false;
      var paths = pane.querySelectorAll('path');
      for (var i = 0; i < paths.length; i++) {
        paths[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (document.querySelector('.leaflet-popup')) return true;
      }
      return false;
    });
    record('marker click', markerClickOk, 'overlay path programmatic click');

    if (markerClickOk) {
      const closeBtn = page.locator('.leaflet-popup-close-button');
      if (await closeBtn.count()) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
    }
    await page.waitForTimeout(400);
    const closed = !(await page.locator('.leaflet-popup').isVisible().catch(() => false));
    record('popup close', closed);

    await page.waitForTimeout(6000);
    const popupAfterClosePoll = await page.locator('.leaflet-popup').isVisible().catch(() => false);
    record('popup remains closed after manual close', !popupAfterClosePoll, 'waited 6s poll');

    await label.click({ force: true });
    await page.waitForSelector('.leaflet-popup', { timeout: 5000 });
    record('popup reopen for poll test', await page.locator('.leaflet-popup').isVisible());

    const patchDriver = 'DRV_TEST_' + Date.now();
    await fetchJson(BASE + '/api/rent/inquiries/' + encodeURIComponent(target.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver: patchDriver }),
    });

    await page.waitForTimeout(6000);
    const popupAfterPoll = await page.locator('.leaflet-popup').isVisible().catch(() => false);
    const popupTextAfter = popupAfterPoll
      ? await page.locator('.leaflet-popup-content').innerText()
      : '';
    record(
      'popup restore after polling',
      popupAfterPoll && popupTextAfter.indexOf(patchDriver) >= 0,
      popupAfterPoll ? 'driver=' + patchDriver : 'popup closed'
    );

    await page.locator('.popup-open-form').click();
    await page.waitForTimeout(800);
    const editId = await page.inputValue('#editId');
    record('adatlap gomb működik', editId === target.id, 'editId=' + editId);

  } catch (err) {
    console.error('Test run error:', err);
    record('test harness', false, err.message);
  } finally {
    await browser.close();
  }

  console.log('\n--- TESZTJEGYZŐKÖNYV (marker-ux-v3) ---');
  const passed = results.filter((r) => r.pass).length;
  console.log('Eredmény: ' + passed + '/' + results.length + ' PASS');
  results.forEach((r) => console.log('  ' + (r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? ' | ' + r.detail : '')));

  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main();
