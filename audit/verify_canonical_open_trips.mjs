/**
 * Kanonikus nyitott-trip bizonyítás – KV01
 */
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000';
const KV01_TRIP = '23-51_Tata1_260608';
const KV01_SHIFT = 'shift_KV01_2026-06-08T21-51-17-416Z';

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json();
  return { status: r.status, json: j };
}

function publicHasKv01(pub) {
  return (pub.vehicles || []).some((v) => String(v.vehicle).toUpperCase() === 'KV01');
}

function openTripsHasKv01(trips) {
  return (trips || []).some((t) => String(t.vehicle_id).toUpperCase() === 'KV01' && t.trip === KV01_TRIP);
}

async function main() {
  const checks = [];
  function check(name, ok, detail) {
    checks.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' – ' + name + ': ' + detail);
  }

  console.log('=== KANONIKUS NYITOTT-TRIP BIZONYÍTÁS ===\n');

  // 1. API alignment
  const [pub, openTrips, positions] = await Promise.all([
    fetchJson(BASE + '/api/vehicle-positions'),
    fetchJson(BASE + '/api/admin/open-trips'),
    fetchJson(BASE + '/api/vehicle-positions'),
  ]);

  if (openTrips.status === 404) {
    console.log('FAIL – /api/admin/open-trips nincs (server restart kell)');
    process.exit(1);
  }

  const kv01Open = (openTrips.json.trips || []).find((t) => t.trip === KV01_TRIP);
  const kv01Pub = (pub.json.vehicles || []).find((v) => v.vehicle === 'KV01');

  check('open-trips endpoint', openTrips.status === 200 && openTrips.json.ok, 'count=' + (openTrips.json.count ?? 0));
  check('KV01 nyitott trip kanonikus listában', !!kv01Open, kv01Open ? kv01Open.trip + ' shift=' + kv01Open.shift : 'nincs');
  check('KV01 public látható', !!kv01Pub, kv01Pub ? kv01Pub.trip : 'nincs');
  check('Public trip = kanonikus trip', kv01Pub && kv01Open && kv01Pub.trip === kv01Open.trip,
    (kv01Pub?.trip || '?') + ' vs ' + (kv01Open?.trip || '?'));

  // 2. Admin UI operative row
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle', timeout: 60000 });
  const gate = await page.evaluate(() => !document.getElementById('admin-login-gate').hidden);
  if (gate) {
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.click('#admin-login-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('admin-login-gate').hidden);
  }
  await page.waitForTimeout(5000);
  await page.click('#operative-vehicles-acc summary');
  await page.waitForTimeout(500);

  const domKv01 = await page.evaluate(() => {
    const tr = document.querySelector('#operative-vehicles-list [data-op-vehicle="KV01"]');
    if (!tr) return null;
    const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim());
    const closeBtn = tr.querySelector('[data-op-close-trips]');
    return {
      tripCell: cells[4],
      closeDisabled: closeBtn ? closeBtn.disabled : true,
      releaseDisabled: tr.querySelector('[data-op-release]')?.disabled,
      cleanupDisabled: tr.querySelector('[data-op-full-cleanup]')?.disabled,
    };
  });

  check('Operatív KV01 sor megvan', !!domKv01, domKv01 ? 'trip cell: ' + domKv01.tripCell : 'nincs');
  check('has_open_trip → close-trip enabled', domKv01 && !domKv01.closeDisabled, 'disabled=' + (domKv01?.closeDisabled ?? '?'));
  check('Trip cell tartalmazza a kanonikus tripet', domKv01 && domKv01.tripCell.includes(KV01_TRIP), domKv01?.tripCell || '');

  await browser.close();

  // 3. Release – trip marad nyitott
  console.log('\n--- Release teszt (KV01) ---');
  const beforeRelease = await fetchJson(BASE + '/api/admin/open-trips');
  const releaseRes = await fetchJson(BASE + '/api/admin/vehicles/KV01/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const afterReleaseOpen = await fetchJson(BASE + '/api/admin/open-trips');
  const afterReleasePub = await fetchJson(BASE + '/api/vehicle-positions');

  check('Release API', releaseRes.status === 200 && releaseRes.json.ok, JSON.stringify(releaseRes.json).slice(0, 80));
  check('Release után trip még nyitott (kanonikus)', openTripsHasKv01(afterReleaseOpen.json.trips), KV01_TRIP);
  check('Release után public még látható', publicHasKv01(afterReleasePub.json), 'KV01 public');

  // 4. Close-trip – trip_end + public eltűnik
  console.log('\n--- Close-trip teszt (KV01) ---');
  const shiftForClose = kv01Open?.shift || KV01_SHIFT;
  const closeRes = await fetchJson(
    BASE + '/api/admin/active-shifts/' + encodeURIComponent(shiftForClose) + '/close-trip',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  );
  const afterCloseOpen = await fetchJson(BASE + '/api/admin/open-trips');
  const afterClosePub = await fetchJson(BASE + '/api/vehicle-positions');

  const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));
  const tripEnd = db.prepare(
    "SELECT id, type, trip, timestamp FROM events WHERE trip=? AND type IN ('trip_end','jarat_zaras') ORDER BY timestamp DESC LIMIT 1"
  ).get(KV01_TRIP);

  check('Close-trip API', closeRes.status === 200 && closeRes.json.ok, closeRes.json.trip_id || JSON.stringify(closeRes.json));
  check('trip_end létrejött', !!tripEnd, tripEnd ? tripEnd.id + ' @ ' + tripEnd.timestamp : 'nincs');
  check('Close után trip nincs kanonikus listában', !openTripsHasKv01(afterCloseOpen.json.trips), 'count=' + afterCloseOpen.json.count);
  check('Close után KV01 public eltűnik', !publicHasKv01(afterClosePub.json), 'vehicles=' + (afterClosePub.json.vehicles || []).map((v) => v.vehicle).join(','));

  db.close();

  const pass = checks.every((c) => c.ok);
  console.log('\n=== ÖSSZESEN: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
