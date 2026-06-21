/**
 * AKTÍV fül műveleti audit – read-only DOM + API bizonyítás
 */
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'audit_screenshots', 'aktiv_tab_audit.json');
const BASE = 'http://localhost:3000';

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

function buttonsIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll('button')].map((b) => ({
    text: (b.textContent || '').trim().replace(/\s+/g, ' '),
    disabled: b.disabled,
    hidden: b.offsetParent === null,
    visible: b.offsetParent !== null && !b.hidden && getComputedStyle(b).visibility !== 'hidden' && getComputedStyle(b).display !== 'none',
    classes: b.className,
    attrs: {
      'data-trip-focus': b.getAttribute('data-trip-focus'),
      'data-trip-close': b.getAttribute('data-trip-close'),
      'data-vehicle-release': b.getAttribute('data-vehicle-release'),
      'data-op-release': b.getAttribute('data-op-release'),
      'data-op-close-trips': b.getAttribute('data-op-close-trips'),
      'data-op-full-cleanup': b.getAttribute('data-op-full-cleanup'),
    },
  }));
}

async function main() {
  const api = {
    trips: await fetchJson(BASE + '/api/admin/trips'),
    drivers: await fetchJson(BASE + '/api/admin/active-drivers'),
    positions: await fetchJson(BASE + '/api/vehicle-positions'),
  };

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle', timeout: 60000 });

  const gate = await page.evaluate(() => {
    const g = document.getElementById('admin-login-gate');
    return g && !g.hidden;
  });
  if (gate) {
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.click('#admin-login-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('admin-login-gate').hidden, { timeout: 10000 });
  }
  await page.waitForTimeout(3000);

  async function auditTab(tabName, tabSelector) {
    await page.click(tabSelector);
    await page.waitForTimeout(800);
    return page.evaluate((tabName) => {
      function cardButtons(selector, vehicleMatch) {
        const cards = [...document.querySelectorAll(selector)];
        const out = {};
        cards.forEach((card) => {
          const text = card.textContent || '';
          ['KV01', 'KV04'].forEach((vid) => {
            if (text.includes(vid)) {
              out[vid] = [...card.querySelectorAll('button')].map((b) => ({
                text: (b.textContent || '').trim(),
                disabled: b.disabled,
                visible: b.offsetParent !== null,
                class: b.className,
              }));
            }
          });
        });
        return out;
      }
      return {
        tab: tabName,
        activeCards: cardButtons('#panel-trips-active .trip-card, #panel-trips-active-mobile .trip-card'),
        shiftCards: cardButtons('#panel-shifts-tab .shift-tab-card, #panel-shifts-tab-mobile .shift-tab-card'),
        operativeRows: (() => {
          const out = {};
          document.querySelectorAll('[data-op-vehicle]').forEach((tr) => {
            const vid = tr.getAttribute('data-op-vehicle');
            if (vid === 'KV01' || vid === 'KV04') {
              out[vid] = [...tr.querySelectorAll('button')].map((b) => ({
                text: (b.textContent || '').trim(),
                disabled: b.disabled,
                visible: b.offsetParent !== null,
                class: b.className,
              }));
            }
          });
          return out;
        })(),
        allActiveButtons: [...document.querySelectorAll('#panel-trips-active button, #panel-trips-active-mobile button')].map((b) => (b.textContent || '').trim()),
        panelHidden: (() => {
          const p = document.getElementById('left-tab-panel-active');
          return p ? p.hidden : null;
        })(),
      };
    }, tabName);
  }

  // JÁRATOK default first
  const tripsTab = await auditTab('JÁRATOK', '[data-left-tab="trips"]');
  const activeTab = await auditTab('AKTÍV', '[data-left-tab="active"]');
  const shiftsTab = await auditTab('MŰSZAKOK', '[data-left-tab="shifts"]');

  // Operatív blokk – nyitás
  await page.click('#operative-vehicles-acc summary');
  await page.waitForTimeout(500);
  const operativeOpen = await page.evaluate(() => {
    const acc = document.getElementById('operative-vehicles-acc');
    const out = {};
    document.querySelectorAll('[data-op-vehicle]').forEach((tr) => {
      const vid = tr.getAttribute('data-op-vehicle');
      if (vid === 'KV01' || vid === 'KV04') {
        out[vid] = [...tr.querySelectorAll('button')].map((b) => ({
          text: (b.textContent || '').trim(),
          disabled: b.disabled,
          visible: b.offsetParent !== null,
        }));
      }
    });
    return { accOpen: acc ? acc.open : null, rows: out };
  });

  await page.click('[data-left-tab="active"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(path.dirname(OUT), 'aktiv_tab_audit.png') });

  await browser.close();

  const report = {
    timestamp: new Date().toISOString(),
    api: {
      activeTrips: (api.trips.trips || []).filter((t) => t.active),
      activeDrivers: (api.drivers.drivers || api.drivers || []),
      kv01Trip: (api.trips.trips || []).find((t) => (t.vehicle_id || '').includes('KV01')),
      kv04Trip: (api.trips.trips || []).find((t) => (t.vehicle_id || '').includes('KV04')),
      kv01Driver: ((api.drivers.drivers || api.drivers) || []).find((d) => (d.vehicle_id || '').includes('KV01')),
      kv04Driver: ((api.drivers.drivers || api.drivers) || []).find((d) => (d.vehicle_id || '').includes('KV04')),
    },
    dom: { tripsTab, activeTab, shiftsTab, operativeOpen },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
