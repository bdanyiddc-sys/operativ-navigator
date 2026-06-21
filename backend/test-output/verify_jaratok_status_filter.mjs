import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:3000';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await page.selectOption('#admin-login-user', { index: 0 });
  await page.fill('#admin-login-pin', 'kisvonat');
  await page.click('#admin-login-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('admin-login-gate')?.hidden === true, { timeout: 15000 });
  await page.click('.left-tab[data-left-tab="trips"]');
  await page.waitForTimeout(2500);

  const defaultState = await page.evaluate(() => {
    const root = document.getElementById('sidebar-controls');
    return {
      text: root?.innerText || '',
      tripBlocks: root?.querySelectorAll('[data-trip-block]').length || 0,
      closedBadges: root?.querySelectorAll('.trip-layer-status-badge.is-closed').length || 0,
      activeBadges: root?.querySelectorAll('.trip-layer-status-badge.is-active').length || 0,
      filterActive: !!root?.querySelector('[data-jaratok-filter="active"].is-active'),
    };
  });

  await page.click('[data-jaratok-filter="all"]');
  await page.waitForTimeout(500);

  const allState = await page.evaluate(() => {
    const root = document.getElementById('sidebar-controls');
    const badges = Array.from(root?.querySelectorAll('.trip-layer-status-badge') || []).map((b) => b.textContent.trim());
    return {
      tripBlocks: root?.querySelectorAll('[data-trip-block]').length || 0,
      badges,
      filterAll: !!root?.querySelector('[data-jaratok-filter="all"].is-active'),
    };
  });

  await browser.close();

  const pass = defaultState.tripBlocks === 0
    && defaultState.closedBadges === 0
    && defaultState.filterActive
    && /Nincs aktív járat/.test(defaultState.text)
    && allState.tripBlocks >= 4
    && allState.badges.every((b) => b === 'LEZÁRT')
    && allState.filterAll;

  console.log(JSON.stringify({ verdict: pass ? 'PASS' : 'FAIL', defaultState, allState }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
