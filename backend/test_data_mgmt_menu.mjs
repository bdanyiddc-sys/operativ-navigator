import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium;
for (const p of [
  path.join(__dirname, 'node_modules', 'playwright'),
  path.join(__dirname, '..', 'frontend', 'public', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
const browser = await chromium.launch({ headless: true }).catch(function () {
  return chromium.launch({ channel: 'msedge', headless: true });
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('http://localhost:3000/rent/admin?v=compact-v2');
const gate = await page.locator('#admin-login-gate:not([hidden])').isVisible().catch(function () { return false; });
if (gate) {
  await page.selectOption('#admin-login-user', { label: 'Admin' });
  await page.fill('#admin-login-pin', 'kisvonat');
  await page.locator('#admin-login-form button[type="submit"]').click();
  await page.waitForTimeout(1500);
}
await page.locator('#btnDataMgmt').click();
await page.waitForTimeout(200);
const menuInfo = await page.evaluate(function () {
  var m = document.getElementById('dataMgmtMenu');
  var r = m.getBoundingClientRect();
  return { hidden: m.hidden, h: r.height, w: r.width, visible: r.height > 10 && r.width > 10 };
});
console.log('Adatkezelés menu:', menuInfo);
await page.locator('#btnOwnerReport').click();
await page.waitForTimeout(200);
const reportInfo = await page.evaluate(function () {
  var mod = document.getElementById('module-analytics');
  return { hidden: mod.hidden, active: mod.classList.contains('is-active'), title: mod.querySelector('h3') ? mod.querySelector('h3').textContent : '' };
});
console.log('Riport modul:', reportInfo);
await browser.close();
process.exit(menuInfo.visible && !reportInfo.hidden ? 0 : 1);
