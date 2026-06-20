import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';

for (const vh of [900, 768, 720, 600]) {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: vh } });
  await page.goto('http://localhost:3000/admin', { waitUntil: 'networkidle', timeout: 60000 });
  if (await page.evaluate(() => !document.getElementById('admin-login-gate').hidden)) {
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.click('#admin-login-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('admin-login-gate').hidden);
  }
  await page.waitForTimeout(3000);
  await page.click('[data-left-tab="shifts"]');
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    document.getElementById('operative-vehicles-acc')?.setAttribute('open', '');
  });
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const sc = document.querySelector('.panel-trips .left-panel-scroll');
    const kv04 = [...document.querySelectorAll('#panel-shifts-tab .shift-tab-card')].find((c) =>
      c.textContent.includes('KV04')
    );
    const scR = sc.getBoundingClientRect();
    const kvR = kv04.getBoundingClientRect();
    const btn = kv04.querySelector('.btn-op-full-cleanup').getBoundingClientRect();
    const beforeTop = sc.scrollTop;
    sc.scrollTop = sc.scrollHeight;
    return {
      vh: innerHeight,
      sh: sc.scrollHeight,
      ch: sc.clientHeight,
      max: sc.scrollHeight - sc.clientHeight,
      kvBottom: kvR.bottom,
      scBottom: scR.bottom,
      btnBottom: btn.bottom,
      btnClipBeforeScroll: btn.bottom > scR.bottom + 1,
      scrollTopAfter: sc.scrollTop,
      canFixByScroll: sc.scrollHeight > sc.clientHeight,
    };
  });
  console.log('vh=' + vh, JSON.stringify(m));
  await browser.close();
}
