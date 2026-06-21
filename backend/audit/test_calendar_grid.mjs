/**
 * Calendar grid layout debug
 * node test_calendar_grid.mjs
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
const OUT = path.join(__dirname, '..', 'test-output', 'calendar_debug.png');

async function main() {
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

  await page.goto(BASE + '/rent/admin?v=caldebug', { waitUntil: 'networkidle', timeout: 60000 });
  await page.selectOption('#admin-login-user', { label: 'Admin' });
  await page.fill('#admin-login-pin', 'kisvonat');
  await page.locator('#admin-login-form button[type="submit"]').click();
  await page.waitForTimeout(2000);
  await page.locator('[data-main-module="calendar"]').click();
  await page.waitForTimeout(800);

  const info = await page.evaluate(function () {
    var el = document.getElementById('calendarGrid');
    var cs = getComputedStyle(el);
    var card = document.getElementById('calendarCard');
    var cardCs = getComputedStyle(card);
    var mod = document.getElementById('module-calendar');
    var modCs = getComputedStyle(mod);
    var days = el.querySelectorAll('.cal-day:not(.is-out)');
    var boxes = [];
    for (var i = 0; i < Math.min(14, days.length); i++) {
      var r = days[i].getBoundingClientRect();
      boxes.push({
        day: days[i].querySelector('.cal-day-num') ? days[i].querySelector('.cal-day-num').textContent : '',
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height)
      });
    }
    var gr = el.getBoundingClientRect();
    return {
      gridDisplay: cs.display,
      gridCols: cs.gridTemplateColumns,
      gridWidth: cs.width,
      gridRect: { x: gr.x, y: gr.y, w: gr.width, h: gr.height },
      cardWidth: cardCs.width,
      modWidth: modCs.width,
      modDisplay: modCs.display,
      childCount: el.children.length,
      boxes: boxes
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: OUT });
  console.log('Screenshot:', OUT);
  await browser.close();

  var row1 = info.boxes.filter(function (b) { return b.day === '1' || b.day === '2' || b.day === '3'; });
  var sameRow = row1.length >= 2 && row1[0].y === row1[1].y;
  console.log(sameRow ? 'PASS: days 1-3 on same row' : 'FAIL: calendar not in 7-column grid');
  process.exit(sameRow ? 0 : 1);
}

main().catch(function (err) {
  console.error(err);
  process.exit(2);
});
