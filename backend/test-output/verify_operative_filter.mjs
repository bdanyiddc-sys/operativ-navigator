/**
 * Verify operative block filter — KV01/KV04 hidden when SZABAD with no shift/trip/public.
 */
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:3000';

async function api(path) {
  const r = await fetch(BASE + path);
  return r.json();
}

async function main() {
  const [drivers, openTrips, publicPos, eventsRes] = await Promise.all([
    api('/api/admin/active-drivers'),
    api('/api/admin/open-trips'),
    api('/api/vehicle-positions'),
    api('/api/events?limit=1500'),
  ]);
  const events = eventsRes.events || [];

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await page.selectOption('#admin-login-user', { index: 0 });
  await page.fill('#admin-login-pin', 'kisvonat');
  await page.click('#admin-login-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('admin-login-gate')?.hidden === true, { timeout: 15000 });
  await page.click('#operative-vehicles-acc summary');
  await page.waitForTimeout(2000);

  const tableText = await page.locator('#operative-vehicles-list').innerText().catch(() => '');
  const hasKv01 = /\bKV01\b/.test(tableText);
  const hasKv04 = /\bKV04\b/.test(tableText);

  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#operative-vehicles-list tbody tr[data-op-vehicle]')).map((tr) => ({
      vehicle: tr.getAttribute('data-op-vehicle'),
      text: tr.innerText.replace(/\s+/g, ' ').trim(),
    }));
  });

  await browser.close();

  const kv01Shift = (drivers.drivers || []).some((d) => d.vehicle_id === 'KV01');
  const kv04Shift = (drivers.drivers || []).some((d) => d.vehicle_id === 'KV04');
  const kv01Trip = (openTrips.trips || []).some((t) => t.vehicle_id === 'KV01');
  const kv04Trip = (openTrips.trips || []).some((t) => t.vehicle_id === 'KV04');
  const kv01Pub = (publicPos.vehicles || []).some((v) => (v.vehicle || v.vehicle_id) === 'KV01');
  const kv04Pub = (publicPos.vehicles || []).some((v) => (v.vehicle || v.vehicle_id) === 'KV04');

  const pass = !hasKv01 && !hasKv04
    && !kv01Shift && !kv04Shift
    && !kv01Trip && !kv04Trip
    && !kv01Pub && !kv04Pub;

  const report = {
    verdict: pass ? 'PASS' : 'FAIL',
    operativeTableRows: rows,
    kv01: { inTable: hasKv01, has_shift: kv01Shift, has_trip: kv01Trip, public_live: kv01Pub },
    kv04: { inTable: hasKv04, has_shift: kv04Shift, has_trip: kv04Trip, public_live: kv04Pub },
    openShifts: drivers.count,
    openTrips: openTrips.count,
    publicCount: publicPos.count,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
