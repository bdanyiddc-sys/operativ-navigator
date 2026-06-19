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
const OUT_DIR = path.join(__dirname, 'test-output', 'map_basemap');
const BUILD = 'rent-admin-map-basemap-v1';

async function login(page) {
  await page.goto(BASE + '/rent/admin?v=' + BUILD, { waitUntil: 'networkidle', timeout: 60000 });
  const gate = await page.locator('#admin-login-gate:not([hidden])').isVisible().catch(function () { return false; });
  if (gate) {
    await page.selectOption('#admin-login-user', { label: 'Admin' });
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.locator('#admin-login-form button[type="submit"]').click();
  }
  await page.waitForFunction(function (b) {
    var el = document.getElementById('admin-debug-banner');
    return el && el.textContent.indexOf(b) >= 0;
  }, BUILD, { timeout: 20000 });
  await page.waitForTimeout(1500);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true }).catch(function () {
    return chromium.launch({ channel: 'msedge', headless: true });
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await login(page);

  for (const mode of ['normal', 'dark', 'satellite']) {
    await page.evaluate(function (m) {
      var btn = document.querySelector('.map-basemap-switcher [data-basemap="' + m + '"]');
      if (btn) btn.click();
    }, mode);
    await page.waitForTimeout(2500);
    const ls = await page.evaluate(function () {
      return localStorage.getItem('rent_map_basemap');
    });
    const out = path.join(OUT_DIR, 'basemap_' + mode + '.png');
    await page.locator('#mapPanel').screenshot({ path: out });
    console.log('Saved', out, '| localStorage=', ls);
  }

  await browser.close();
}

main().catch(function (e) { console.error(e); process.exit(2); });
