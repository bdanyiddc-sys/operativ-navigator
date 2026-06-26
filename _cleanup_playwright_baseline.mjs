import { chromium } from 'file:///D:/cursor/operativ-navigator_260614/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:3000';
const pages = ['/public/', '/driver/', '/admin', '/rent/public', '/rent/admin'];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
for (const p of pages) {
  const page = await browser.newPage();
  const errors = [];
  const n404 = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGE:' + e.message));
  page.on('response', (r) => {
    if (r.status() === 404 && /localhost:3000/.test(r.url()) && !/favicon/.test(r.url())) n404.push(r.url());
  });
  let st = 0;
  try {
    const resp = await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
    st = resp?.status ?? 0;
    await page.waitForTimeout(1200);
    const c = page.locator('[data-kv-analytics-consent="no_location"], [data-kv-analytics-consent="accept"]').first();
    if (await c.count()) await c.click({ force: true }).catch(() => {});
  } catch (e) {
    errors.push('GOTO:' + e.message);
  }
  results.push({ page: p, httpStatus: st, consoleErrors: errors.slice(0, 6), local404: n404.slice(0, 6) });
  await page.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
