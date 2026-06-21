/**
 * Operatív blokk audit – élő admin JS + API (read-only)
 */
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:3000';

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function main() {
  const [driversData, positionsData, eventsData, tripsData] = await Promise.all([
    fetchJson(BASE + '/api/admin/active-drivers'),
    fetchJson(BASE + '/api/vehicle-positions'),
    fetchJson(BASE + '/api/events?limit=50000'),
    fetchJson(BASE + '/api/admin/trips'),
  ]);

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle', timeout: 60000 });

  const gate = await page.evaluate(() => !document.getElementById('admin-login-gate').hidden);
  if (gate) {
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.click('#admin-login-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('admin-login-gate').hidden);
  }
  await page.waitForTimeout(6000);
  await page.waitForFunction(() => {
    const el = document.getElementById('operative-vehicles-list');
    return el && el.querySelector('[data-op-vehicle]');
  }, { timeout: 30000 });
  await page.click('#operative-vehicles-acc summary');
  await page.waitForTimeout(500);

  const dom = await page.evaluate(() => {
    const root = document.getElementById('operative-vehicles-list');
    const rows = root ? [...root.querySelectorAll('[data-op-vehicle]')].map((tr) => {
      const vid = tr.getAttribute('data-op-vehicle');
      const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim());
      const buttons = [...tr.querySelectorAll('button')].map((b) => ({
        text: (b.textContent || '').trim(),
        disabled: b.disabled,
        visible: b.offsetParent !== null,
      }));
      return { vehicle_id: vid, cells, buttons };
    }) : [];
    return { rows, operativeOpen: document.getElementById('operative-vehicles-acc')?.open };
  });

  const inBrowser = await page.evaluate(() => ({
    rows: typeof lastOperativeRows !== 'undefined' ? lastOperativeRows : [],
    drivers: typeof lastActiveDrivers !== 'undefined' ? lastActiveDrivers.length : 0,
    public: typeof lastPublicVehiclePositionsApi !== 'undefined' ? lastPublicVehiclePositionsApi.length : 0,
  }));

  await browser.close();

  const drivers = driversData.drivers || [];
  const positions = positionsData.vehicles || [];
  const driverVehicles = [...new Set(drivers.map((d) => String(d.vehicle_id || '').toUpperCase()).filter(Boolean))];
  const publicVehicles = [...new Set(positions.map((p) => String(p.vehicle || p.vehicle_id || '').toUpperCase()).filter(Boolean))];
  const operativeRows = inBrowser.rows || [];
  const operativeVids = new Set(operativeRows.map((r) => r.vehicle_id));
  const domVids = new Set(dom.rows.map((r) => r.vehicle_id));

  console.log('=== ÉLŐ OPERATÍV AUDIT (admin JS + API) ===\n');
  console.log('API active-drivers:', drivers.length, '→ járművek:', driverVehicles.join(', '));
  console.log('API vehicle-positions:', positions.length, '→', publicVehicles.join(', '));
  console.log('buildOperativeVehicleRows sorok:', operativeRows.length);
  console.log('lastActiveDrivers:', inBrowser.drivers, 'public positions:', inBrowser.public);
  console.log('DOM operatív sorok:', dom.rows.length, dom.rows.map((r) => r.vehicle_id).join(', '));
  console.log('');

  const q2 = publicVehicles.filter((v) => !operativeVids.has(v));
  const q3 = driverVehicles.filter((v) => !operativeVids.has(v));
  console.log('2. Public DE nincs operatívban:', q2.length ? 'FAIL ' + q2.join(', ') : 'PASS');
  console.log('3. Nyitott shift DE nincs operatívban:', q3.length ? 'FAIL ' + q3.join(', ') : 'PASS');
  console.log('');

  console.log('=== buildOperativeVehicleRows (élő admin memória) ===');
  for (const r of operativeRows) {
    console.log(JSON.stringify({
      vehicle_id: r.vehicle_id,
      status: r.status,
      has_shift: r.has_shift,
      has_open_trip: r.has_open_trip,
      public_live: r.public_live,
      open_trips: r.open_trips,
      map: r.map_lat != null,
      release_ok: r.has_shift,
      close_ok: r.has_open_trip,
      cleanup_ok: r.has_shift || r.has_open_trip,
    }));
  }

  console.log('\n=== KV01 / KV04 DOM gombok (operatív sor) ===');
  for (const vid of ['KV01', 'KV04']) {
    const row = dom.rows.find((r) => r.vehicle_id === vid);
    const mem = operativeRows.find((r) => r.vehicle_id === vid);
    console.log(vid + ':', row ? row.buttons : 'NINCS DOM sor');
    console.log('  memória:', mem || 'NINCS');
  }

  console.log('\n=== INclusion szabály (kód) ===');
  console.log('include = has_shift || has_open_trip || public_live || recentGps || recentHb || stale');
}

main().catch((e) => { console.error(e); process.exit(1); });
