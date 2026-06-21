/**
 * One-off PRE-DEPLOY operator flow test — not part of app runtime.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { chromium } from '../../frontend/public/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:3000';
const OUT_DIR = process.argv[2];
const DB_PATH = path.resolve('data/events.db');
const VEHICLE = 'KV10';
const DRIVER = 'DRV10';
const PIN = '1234';
const CITY = 'Teszt01';
const ROUTE = 'Teszt01';

const report = { steps: [], verdict: 'PENDING', vehicle: VEHICLE, driver: DRIVER };

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const shiftId = `shift_${VEHICLE}_${ts()}`;
let tripId = `trip_${VEHICLE}_${ts()}`;

async function api(method, urlPath, body) {
  const opts = { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + urlPath, opts);
  let data;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, ok: r.ok, data };
}

function dbState(shiftIdArg, tripIdArg) {
  const db = new Database(DB_PATH, { readonly: true });
  const shift = db.prepare('SELECT * FROM active_shifts WHERE shift_id = ?').get(shiftIdArg);
  const openShifts = db.prepare('SELECT shift_id, vehicle_id, closed_at FROM active_shifts WHERE closed_at IS NULL').all();
  const tripEnd = tripIdArg
    ? db.prepare("SELECT id, type, trip, timestamp FROM events WHERE trip = ? AND type = 'trip_end' ORDER BY created_at DESC LIMIT 1").get(tripIdArg)
    : null;
  const shiftEnd = shiftIdArg
    ? db.prepare("SELECT id, type, shift, timestamp FROM events WHERE shift = ? AND type = 'shift_end' ORDER BY created_at DESC LIMIT 1").get(shiftIdArg)
    : null;
  db.close();
  return { shift, openShifts, tripEnd, shiftEnd };
}

function step(name, checks) {
  report.steps.push({ name, ...checks });
}

async function screenshot(page, name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

async function adminLogin(page) {
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#admin-login-form', { timeout: 15000 });
  await page.selectOption('#admin-login-user', { index: 0 });
  await page.fill('#admin-login-pin', 'kisvonat');
  await page.click('#admin-login-form button[type="submit"]');
  await page.waitForFunction(() => {
    const g = document.getElementById('admin-login-gate');
    return g && g.hidden === true;
  }, { timeout: 15000 });
}

async function clickLeftTab(page, tab) {
  await page.click(`.left-tab[data-left-tab="${tab}"]`);
  await page.waitForTimeout(800);
}

async function refreshAdmin(page) {
  await page.evaluate(() => {
    if (typeof refresh === 'function') return refresh();
  }).catch(() => {});
  await page.waitForTimeout(1200);
}

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // cleanup stale KV10 lock from prior runs
  await api('POST', `/api/admin/vehicles/${VEHICLE}/release`, {});

  // STEP 1 — driver shift start
  const startResp = await api('POST', '/api/shifts/start', {
    shift_id: shiftId,
    vehicle_id: VEHICLE,
    driver_id: DRIVER,
    driver_name: 'NEV10',
    pin: PIN,
    route: ROUTE,
    city: CITY,
  });
  const muszakResp = await api('POST', '/api/events', {
    id: `evt_muszak_${Date.now()}`,
    type: 'muszak_inditas',
    shift: shiftId,
    driver_id: DRIVER,
    driver_name: 'NEV10',
    vehicle_id: VEHICLE,
    city: CITY,
    timestamp: new Date().toISOString(),
    lat: 47.4979,
    lng: 19.0402,
  });
  const driversResp = await api('GET', '/api/admin/active-drivers');
  const db1 = dbState(shiftId, null);
  const driverListed = (driversResp.data?.drivers || []).some((d) => d.shift_id === shiftId || d.vehicle_id === VEHICLE);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await adminLogin(page);
  await clickLeftTab(page, 'shifts');
  await refreshAdmin(page);
  const shiftsHtml = await page.locator('#panel-shifts-tab').innerText();
  const ss1 = await screenshot(page, '01_muszakok_after_shift_start');

  step('1 — Új sofőr belépés / műszak indítás', {
    api: { shiftStart: startResp, muszakEvent: muszakResp, activeDrivers: driversResp },
    db: db1,
    screenshot: ss1,
    pass: startResp.ok && muszakResp.ok && !!db1.shift && db1.shift.closed_at == null && driverListed && shiftsHtml.includes(VEHICLE),
    notes: [
      `active_shifts létrejött: ${!!db1.shift}`,
      `MŰSZAKOK tab ${VEHICLE}: ${shiftsHtml.includes(VEHICLE)}`,
    ],
  });

  // STEP 2 — trip start
  const tripStartResp = await api('POST', '/api/events', [
    {
      id: `evt_trip_start_${Date.now()}`,
      type: 'trip_start',
      trip: tripId,
      shift: shiftId,
      driver_id: DRIVER,
      driver_name: 'NEV10',
      vehicle_id: VEHICLE,
      vehicle_name: VEHICLE,
      city: CITY,
      schedule: ROUTE,
      start_time: new Date().toISOString(),
      lat: 47.4979,
      lng: 19.0402,
      timestamp: new Date().toISOString(),
    },
    {
      id: `evt_track_${Date.now()}`,
      type: 'track',
      trip: tripId,
      shift: shiftId,
      lat: 47.4985,
      lng: 19.041,
      timestamp: new Date().toISOString(),
    },
  ]);
  const openTripsResp = await api('GET', '/api/admin/open-trips');
  const publicBeforeResp = await api('GET', '/api/vehicle-positions');
  const tripListed = (openTripsResp.data?.trips || openTripsResp.data?.open_trips || []).some((t) => (t.trip || t.id) === tripId)
    || JSON.stringify(openTripsResp.data).includes(tripId);

  await clickLeftTab(page, 'active');
  await refreshAdmin(page);
  const activeHtml = await page.locator('#panel-trips-active').innerText();
  const ss2 = await screenshot(page, '02_aktiv_after_trip_start');
  const publicHasVehicle = (publicBeforeResp.data?.vehicles || []).some((v) => v.vehicle_id === VEHICLE || v.id === VEHICLE);

  step('2 — Új járat indítás', {
    api: { tripStart: tripStartResp, openTrips: openTripsResp, vehiclePositions: publicBeforeResp },
    db: dbState(shiftId, tripId),
    screenshot: ss2,
    pass: tripStartResp.ok && tripListed && activeHtml.includes(tripId),
    notes: [
      `open trip: ${tripListed}`,
      `AKTÍV tab trip: ${activeHtml.includes(tripId)}`,
      `public vehicle-positions ${VEHICLE}: ${publicHasVehicle}`,
    ],
  });

  // STEP 3 — close trip from AKTÍV tab
  page.once('dialog', (d) => d.accept());
  await page.click(`button[data-trip-close="${tripId}"]`);
  await page.waitForTimeout(2000);
  await refreshAdmin(page);
  const openTripsAfter = await api('GET', '/api/admin/open-trips');
  const publicAfterTrip = await api('GET', '/api/vehicle-positions');
  const db3 = dbState(shiftId, tripId);
  const activeHtmlAfter = await page.locator('#panel-trips-active').innerText();
  const ss3 = await screenshot(page, '03_aktiv_after_trip_close');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const ss3public = await screenshot(page, '03_public_after_trip_close');
  const tripStillOpen = JSON.stringify(openTripsAfter.data).includes(tripId);
  const publicStill = (publicAfterTrip.data?.vehicles || []).some((v) => (v.trip || v.trip_id || '') === tripId || v.vehicle_id === VEHICLE);

  step('3 — Járat lezárás (AKTÍV → Járat zárása)', {
    api: { openTripsAfter, vehiclePositions: publicAfterTrip },
    db: db3,
    screenshots: [ss3, ss3public],
    pass: !!db3.tripEnd && !tripStillOpen && !activeHtmlAfter.includes(tripId) && !publicStill,
    notes: [
      `trip_end létrejött: ${!!db3.tripEnd}`,
      `AKTÍV tabból eltűnt: ${!activeHtmlAfter.includes(tripId)}`,
      `public vehicle-positions üres ${VEHICLE}: ${!publicStill}`,
    ],
  });

  // STEP 4 — shift close from MŰSZAKOK (Vonat felszabadítása — elérhető UI)
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  const gateHidden = await page.evaluate(() => {
    const g = document.getElementById('admin-login-gate');
    return !!(g && g.hidden);
  });
  if (!gateHidden) await adminLogin(page);
  await clickLeftTab(page, 'shifts');
  await refreshAdmin(page);
  page.once('dialog', (d) => d.accept());
  await page.click(`button[data-op-release="${VEHICLE}"]`);
  await page.waitForTimeout(2000);
  await refreshAdmin(page);
  const driversAfter = await api('GET', '/api/admin/active-drivers');
  const db4 = dbState(shiftId, tripId);
  const shiftsHtmlAfter = await page.locator('#panel-shifts-tab').innerText();
  const ss4 = await screenshot(page, '04_muszakok_after_shift_close');
  const shiftStillListed = (driversAfter.data?.drivers || []).some((d) => d.shift_id === shiftId);

  step('4 — Műszak lezárás (MŰSZAKOK → Vonat felszabadítása)', {
    api: { activeDriversAfter: driversAfter },
    db: db4,
    screenshot: ss4,
    pass: !!db4.shift?.closed_at && !!db4.shiftEnd && !shiftStillListed && !shiftsHtmlAfter.includes(VEHICLE),
    notes: [
      `active_shifts.closed_at kitöltve: ${!!db4.shift?.closed_at}`,
      `shift_end event: ${!!db4.shiftEnd}`,
      `MŰSZAKOK tabból eltűnt: ${!shiftsHtmlAfter.includes(VEHICLE)}`,
    ],
  });

  // STEP 5 — cleanup regression (release + close-trip chain, API-only)
  const V2 = 'KV11';
  const shiftId2 = `shift_${V2}_${ts()}`;
  const tripId2 = `trip_${V2}_${ts()}`;
  await api('POST', `/api/admin/vehicles/${V2}/release`, {});
  const cStart = await api('POST', '/api/shifts/start', {
    shift_id: shiftId2, vehicle_id: V2, driver_id: 'DRV11', driver_name: 'NEV11', pin: PIN, route: 'Tata-1', city: 'Tata',
  });
  await api('POST', '/api/events', { id: `evt_m2_${Date.now()}`, type: 'muszak_inditas', shift: shiftId2, driver_id: 'DRV11', vehicle_id: V2, timestamp: new Date().toISOString() });
  const cTrip = await api('POST', '/api/events', [{
    id: `evt_ts2_${Date.now()}`, type: 'trip_start', trip: tripId2, shift: shiftId2, driver_id: 'DRV11', vehicle_id: V2, vehicle_name: V2, city: 'Tata', lat: 47.65, lng: 18.32, timestamp: new Date().toISOString(),
  }, { id: `evt_tr2_${Date.now()}`, type: 'track', trip: tripId2, shift: shiftId2, lat: 47.651, lng: 18.321, timestamp: new Date().toISOString() }]);
  const openBeforeCleanup = await api('GET', '/api/admin/open-trips');
  const relCleanup = await api('POST', `/api/admin/vehicles/${V2}/release`, {});
  const closeTripCleanup = await api('POST', `/api/admin/active-shifts/${encodeURIComponent(shiftId2)}/close-trip`, {});
  const openAfterCleanup = await api('GET', '/api/admin/open-trips');
  const publicAfterCleanup = await api('GET', '/api/vehicle-positions');
  const db5 = dbState(shiftId2, tripId2);
  const kickCount = (() => {
    const db = new Database(DB_PATH, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS c FROM driver_kicks WHERE shift_id = ?').get(shiftId2);
    db.close();
    return n?.c || 0;
  })();
  step('5 — Cleanup regresszió (release → close-trip lánc)', {
    api: { shiftStart: cStart, tripStart: cTrip, release: relCleanup, closeTrip: closeTripCleanup, openBeforeCleanup, openAfterCleanup, vehiclePositions: publicAfterCleanup },
    db: { ...db5, driver_kicks_count: kickCount },
    pass: cStart.ok && cTrip.ok && relCleanup.ok && closeTripCleanup.ok
      && !!db5.shift?.closed_at && !!db5.shiftEnd && !!db5.tripEnd
      && !JSON.stringify(openAfterCleanup.data).includes(tripId2)
      && !(publicAfterCleanup.data?.vehicles || []).some((v) => v.vehicle === V2 || v.vehicle_id === V2)
      && kickCount === 0,
    notes: [
      `cleanup release ok: ${relCleanup.ok}`,
      `cleanup close-trip ok: ${closeTripCleanup.ok}`,
      `shift_end: ${!!db5.shiftEnd}`,
      `trip_end: ${!!db5.tripEnd}`,
      `driver_kicks: ${kickCount}`,
    ],
  });

  await browser.close();

  const allPass = report.steps.every((s) => s.pass);
  report.verdict = allPass ? 'PASS' : 'FAIL';
  report.shiftId = shiftId;
  report.tripId = tripId;

  const outJson = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(allPass ? 0 : 1);
} catch (err) {
  report.verdict = 'FAIL';
  report.error = String(err && err.stack ? err.stack : err);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.error(report.error);
  process.exit(1);
}
