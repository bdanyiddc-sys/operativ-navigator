import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 720 } });
await page.goto('http://localhost:3000/admin', { waitUntil: 'networkidle', timeout: 60000 });
if (await page.evaluate(() => !document.getElementById('admin-login-gate').hidden)) {
  await page.fill('#admin-login-pin', 'kisvonat');
  await page.click('#admin-login-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('admin-login-gate').hidden);
}
await page.waitForTimeout(3000);
await page.click('[data-left-tab="shifts"]');
await page.waitForTimeout(1000);
const m = await page.evaluate(() => {
  const ids = ['acc-trips', 'panel-trips', 'operative-vehicles-acc'];
  const sel = ['.panel-trips', '.panel-trips .panel-acc', '.panel-trips .panel-body', '.panel-trips .left-panel-scroll', 'main.layout', 'body'];
  const out = { vh: innerHeight, bodyScrollH: document.body.scrollHeight, bodyClientH: document.body.clientHeight };
  for (const s of sel) {
    const el = document.querySelector(s);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    out[s] = { h: r.height, bottom: r.bottom, overflow: st.overflow, overflowY: st.overflowY, flex: st.flex, minH: st.minHeight, maxH: st.maxHeight };
  }
  return out;
});
console.log(JSON.stringify(m, null, 2));
await browser.close();
