/**
 * MŰSZAKOK tab operátori audit – KV01 / KV04
 */
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000/admin';
const OUT = path.join(__dirname, '..', 'audit_screenshots', 'shifts_tab_audit.png');

async function auditVehicle(page, vid) {
  const cards = page.locator('#panel-shifts-tab .shift-tab-card').filter({ hasText: vid });
  const count = await cards.count();
  if (!count) return { vid, found: false };

  const first = cards.first();
  const box = await first.boundingBox();
  const scroll = await page.evaluate(() => {
    const sc = document.querySelector('.panel-trips .left-panel-scroll');
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight };
  });

  const buttons = await first.evaluate((card) => {
    const names = ['btn-op-show-map', 'btn-op-release', 'btn-op-close-trip', 'btn-op-full-cleanup'];
    const labels = ['Térképen mutat', 'Vonat felszabadítása', 'Járat lezárása', 'Teljes takarítás'];
    return names.map((cls, i) => {
      const btn = card.querySelector('.' + cls);
      if (!btn) return { label: labels[i], missing: true };
      const r = btn.getBoundingClientRect();
      const cardR = card.getBoundingClientRect();
      const fullyInCard = r.top >= cardR.top && r.bottom <= cardR.bottom + 1;
      return {
        label: labels[i],
        text: (btn.textContent || '').trim(),
        disabled: btn.disabled,
        visible: r.width > 0 && r.height > 0,
        fullyInCard,
        bottomClip: r.bottom - cardR.bottom,
      };
    });
  });

  return { vid, found: true, cardBox: box, scroll, buttons };
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });

  if (await page.evaluate(() => !document.getElementById('admin-login-gate').hidden)) {
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.click('#admin-login-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('admin-login-gate').hidden);
  }
  await page.waitForTimeout(5000);
  await page.click('[data-left-tab="shifts"]');
  await page.waitForTimeout(1500);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });

  const results = {};
  for (const vid of ['KV01', 'KV04']) {
    results[vid] = await auditVehicle(page, vid);
  }

  await browser.close();

  console.log('=== MŰSZAKOK TAB OPERÁTORI AUDIT ===\n');

  let allPass = true;
  for (const vid of ['KV01', 'KV04']) {
    const r = results[vid];
    console.log('## ' + vid);
    if (!r.found) {
      console.log('   Nincs műszak kártya → SKIP (nincs aktív shift)\n');
      continue;
    }
    const release = r.buttons.find((b) => b.label === 'Vonat felszabadítása');
    const close = r.buttons.find((b) => b.label === 'Járat lezárása');
    const cleanup = r.buttons.find((b) => b.label === 'Teljes takarítás');
    const map = r.buttons.find((b) => b.label === 'Térképen mutat');

    const checks = [
      ['release elérhető', release && !release.missing && release.visible],
      ['close-trip gomb megvan', close && !close.missing && close.visible],
      ['cleanup gomb megvan', cleanup && !cleanup.missing && cleanup.visible],
      ['release enabled', release && !release.disabled],
      ['minden gomb a kártyán belül', r.buttons.every((b) => !b.missing && b.fullyInCard)],
      ['nincs overflow clip (kártya)', r.buttons.every((b) => b.bottomClip <= 2)],
    ];
    checks.forEach(([name, ok]) => {
      console.log('   ' + (ok ? 'PASS' : 'FAIL') + ' – ' + name);
      if (!ok) allPass = false;
    });
    r.buttons.forEach((b) => {
      console.log('     ' + b.label + ': disabled=' + b.disabled + ' inCard=' + b.fullyInCard);
    });
    console.log('');
  }

  console.log('Screenshot:', OUT);
  console.log('ÖSSZESEN:', allPass ? 'PASS' : 'FAIL');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
