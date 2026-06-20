/**
 * MŰSZAKOK layout audit – scroll + clip + screenshots
 */
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000/admin';
const OUT_DIR = path.join(__dirname, '..', 'audit_screenshots', 'layout_shifts');

function metrics(page) {
  return page.evaluate(() => {
    const sc = document.querySelector('.panel-trips .left-panel-scroll');
    const kv04 = [...document.querySelectorAll('#panel-shifts-tab .shift-tab-card')].find((c) =>
      (c.textContent || '').includes('KV04')
    );
    const legend = document.querySelector('.map-legend-fixed');
    const mapWrap = document.querySelector('.panel-map .map-wrap');
    const scR = sc?.getBoundingClientRect();
    const kvR = kv04?.getBoundingClientRect();
    const legR = legend?.getBoundingClientRect();
    const mapR = mapWrap?.getBoundingClientRect();
    const lastBtn = kv04?.querySelector('.btn-op-full-cleanup');
    const btnR = lastBtn?.getBoundingClientRect();
    const opAcc = document.querySelector('.operative-vehicles-acc');
    const footer = document.querySelector('.panel-trips > .trips-daily-report-footer');
    return {
      scroll: sc
        ? {
            scrollHeight: sc.scrollHeight,
            clientHeight: sc.clientHeight,
            scrollTop: sc.scrollTop,
            maxScroll: sc.scrollHeight - sc.clientHeight,
            overflowY: getComputedStyle(sc).overflowY,
          }
        : null,
      scViewport: scR ? { top: scR.top, bottom: scR.bottom, height: scR.height } : null,
      kv04: kvR
        ? {
            top: kvR.top,
            bottom: kvR.bottom,
            height: kvR.height,
            fullyInScrollViewport:
              scR && kvR.top >= scR.top - 1 && kvR.bottom <= scR.bottom + 1,
            lastBtnInView:
              scR && btnR
                ? btnR.top >= scR.top - 1 && btnR.bottom <= scR.bottom + 1
                : null,
          }
        : null,
      legend: legR && mapR
        ? {
            bottom: legR.bottom,
            mapBottom: mapR.bottom,
            clipped: legR.bottom > mapR.bottom + 1,
          }
        : null,
      opAccTop: opAcc?.getBoundingClientRect().top ?? null,
      footerTop: footer?.getBoundingClientRect().top ?? null,
    };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });

  if (await page.evaluate(() => !document.getElementById('admin-login-gate').hidden)) {
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.click('#admin-login-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('admin-login-gate').hidden);
  }
  await page.waitForTimeout(4000);
  await page.click('[data-left-tab="shifts"]');
  await page.waitForTimeout(1500);

  const topMetrics = await metrics(page);
  await page.screenshot({ path: path.join(OUT_DIR, '01_shifts_top.png') });

  await page.evaluate(() => {
    const sc = document.querySelector('.panel-trips .left-panel-scroll');
    if (sc) sc.scrollTop = 0;
  });
  await page.waitForTimeout(200);

  const kv04Box = await page.evaluate(() => {
    const kv04 = [...document.querySelectorAll('#panel-shifts-tab .shift-tab-card')].find((c) =>
      (c.textContent || '').includes('KV04')
    );
    if (!kv04) return null;
    kv04.scrollIntoView({ block: 'center' });
    return kv04.getBoundingClientRect();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '03_kv04_card.png') });

  await page.evaluate(() => {
    const sc = document.querySelector('.panel-trips .left-panel-scroll');
    const kv04 = [...document.querySelectorAll('#panel-shifts-tab .shift-tab-card')].find((c) =>
      (c.textContent || '').includes('KV04')
    );
    if (sc && kv04) {
      const btn = kv04.querySelector('.btn-op-full-cleanup');
      if (btn) btn.scrollIntoView({ block: 'end', behavior: 'instant' });
      else kv04.scrollIntoView({ block: 'end', behavior: 'instant' });
    } else if (sc) {
      sc.scrollTop = sc.scrollHeight;
    }
  });
  await page.waitForTimeout(300);
  const bottomMetrics = await metrics(page);
  await page.screenshot({ path: path.join(OUT_DIR, '02_shifts_bottom.png') });
  await page.screenshot({ path: path.join(OUT_DIR, '04_page_bottom.png'), fullPage: false });

  await browser.close();

  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' – ' + name + (detail ? ': ' + detail : ''));
  };

  console.log('=== LAYOUT AUDIT MŰSZAKOK ===\n');
  console.log('Top metrics:', JSON.stringify(topMetrics.scroll));
  console.log('Bottom metrics:', JSON.stringify(bottomMetrics.scroll));
  console.log('KV04 bottom:', JSON.stringify(bottomMetrics.kv04));
  console.log('Legend:', JSON.stringify(bottomMetrics.legend));
  console.log('');

  add(
    'scroll elérhető',
    (topMetrics.scroll?.maxScroll ?? 0) > 0 || (bottomMetrics.scroll?.maxScroll ?? 0) > 0,
    'maxScroll=' + (bottomMetrics.scroll?.maxScroll ?? 0)
  );
  add(
    'KV04 alj görgetve látható',
    bottomMetrics.kv04?.lastBtnInView === true,
    'lastBtnInView=' + bottomMetrics.kv04?.lastBtnInView
  );
  add(
    'KV04 utolsó gomb látható',
    bottomMetrics.kv04?.lastBtnInView === true,
    'lastBtnInView=' + bottomMetrics.kv04?.lastBtnInView
  );
  add(
    'térkép legenda nem vágódik',
    bottomMetrics.legend?.clipped !== true,
    JSON.stringify(bottomMetrics.legend)
  );
  add(
    'Operatív blokk nem takarja KV04 alját',
    bottomMetrics.kv04 && bottomMetrics.opAccTop
      ? bottomMetrics.kv04.lastBtnInView === true
      : false,
    'lastBtnInView=' + bottomMetrics.kv04?.lastBtnInView
  );

  const allPass = checks.every((c) => c.ok);
  console.log('\nÖSSZESEN: ' + (allPass ? 'PASS' : 'FAIL'));
  console.log('Screenshots: ' + OUT_DIR);
  if (kv04Box) console.log('KV04 box (center scroll):', kv04Box);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
