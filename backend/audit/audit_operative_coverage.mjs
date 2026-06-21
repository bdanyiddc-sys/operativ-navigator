/**
 * Operatív járművek blokk – teljes lefedettség audit (read-only)
 * Ugyanaz a logika mint buildOperativeVehicleRows + renderOperativeVehicleRowHtml
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));
const STALE_MS = 30 * 60 * 1000;
const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);

function norm(v) {
  return String(v || '').trim().toUpperCase();
}

function payloadOf(ev) {
  if (ev.payload && typeof ev.payload === 'object') return ev.payload;
  try { return JSON.parse(ev.payload_json || '{}'); } catch { return {}; }
}

function eventTrip(ev) {
  return ev.trip || payloadOf(ev).trip || null;
}

function allEvents() {
  return db.prepare('SELECT * FROM events ORDER BY timestamp').all().map((r) => {
    const p = payloadOf(r);
    return { ...r, payload: p, type: r.type, trip: r.trip || p.trip, shift: r.shift || p.shift };
  });
}

function collectAllOpenTrips(events) {
  const open = {};
  const chrono = [...events].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  for (const ev of chrono) {
    const id = eventTrip(ev);
    if (!id) continue;
    if (TRIP_START.has(String(ev.type || '').toLowerCase())) {
      const p = payloadOf(ev);
      open[id] = { trip: id, shift: ev.shift || p.shift || null, vehicle_id: p.vehicle_id || ev.vehicle_id || null, driver_id: p.driver_id || null };
    }
    if (TRIP_END.has(String(ev.type || '').toLowerCase())) delete open[id];
  }
  return Object.values(open);
}

function isShiftStaleForDisplay(d) {
  if (!d) return false;
  const status = String(d.display_status || d.status || '').toUpperCase();
  if (status === 'STALE') return true;
  const last = d.last_gps_at || d.last_heartbeat_at || d.last_track_at || d.started_at;
  if (!last) return false;
  return Date.now() - new Date(last).getTime() >= STALE_MS;
}

function isOperativeStale(lastIso, shiftMeta) {
  if (shiftMeta && isShiftStaleForDisplay(shiftMeta)) return true;
  if (!lastIso) return !!shiftMeta;
  return Date.now() - new Date(lastIso).getTime() >= STALE_MS;
}

function deriveOperativeStatus(row) {
  const stale = isOperativeStale(row.last_gps_at || row.last_heartbeat_at, row.shift_meta);
  if (row.has_shift && stale) return 'BERAGADT_LOCK';
  if (row.has_open_trip && (stale || (row.public_live && !row.has_shift))) return 'BERAGADT_TRIP';
  if (stale && (row.has_shift || row.has_open_trip || row.public_live)) return 'STALE';
  if (row.has_shift || row.has_open_trip || row.public_live) return 'AKTÍV';
  return 'SZABAD';
}

function publicVehiclesFromEvents(events) {
  const open = collectAllOpenTrips(events);
  const out = [];
  for (const t of open) {
    const track = db.prepare(
      "SELECT lat,lng,timestamp FROM events WHERE trip=? AND type IN ('track','auto_track') AND lat IS NOT NULL ORDER BY timestamp DESC LIMIT 1"
    ).get(t.trip);
    if (!track) continue;
    out.push({
      vehicle: norm(t.vehicle_id),
      vehicle_id: norm(t.vehicle_id),
      trip: t.trip,
      lat: track.lat,
      lng: track.lng,
      last_gps: track.timestamp,
      passengers: null,
    });
  }
  // merge API-style passenger from last passenger event
  for (const p of out) {
    const pe = db.prepare("SELECT payload_json FROM events WHERE trip=? AND type='passenger' ORDER BY timestamp DESC LIMIT 1").get(p.trip);
    if (pe) {
      try {
        const pl = JSON.parse(pe.payload_json || '{}');
        p.passengers = pl.passengers ?? pl.count ?? null;
      } catch {}
    }
  }
  return out.filter((p) => p.vehicle);
}

function activeDriversFromDb() {
  return db.prepare('SELECT * FROM active_shifts WHERE closed_at IS NULL').all().map((d) => ({
    shift_id: d.shift_id,
    driver_id: d.driver_id,
    driver_name: d.driver_name,
    vehicle_id: d.vehicle_id,
    vehicle_name: d.vehicle_name,
    city: d.city,
    started_at: d.started_at,
    last_gps_at: d.last_gps_at || d.last_track_at,
    last_track_at: d.last_track_at,
    last_heartbeat_at: d.last_heartbeat_at,
    status: d.status || 'ACTIVE',
    display_status: d.display_status || d.status || 'ACTIVE',
  }));
}

function buildOperativeVehicleRows(events, drivers, publicVehicles) {
  const byVehicle = {};
  function ensure(rawId) {
    const vid = norm(rawId);
    if (!vid) return null;
    if (!byVehicle[vid]) {
      byVehicle[vid] = {
        vehicle_id: vid,
        driver_id: null,
        shift_id: null,
        has_shift: false,
        has_open_trip: false,
        public_live: false,
        open_trips: [],
        last_gps_at: null,
        last_heartbeat_at: null,
        shift_meta: null,
        map_lat: null,
        map_lng: null,
        focus_trip_id: null,
        status: 'SZABAD',
      };
    }
    return byVehicle[vid];
  }

  for (const d of drivers || []) {
    const row = ensure(d.vehicle_id || d.vehicle_name);
    if (!row) continue;
    row.has_shift = true;
    row.shift_id = d.shift_id || row.shift_id;
    row.shift_meta = d;
    row.driver_id = d.driver_id || row.driver_id;
    row.last_gps_at = d.last_gps_at || d.last_track_at || row.last_gps_at;
    row.last_heartbeat_at = d.last_heartbeat_at || row.last_heartbeat_at;
  }

  for (const t of collectAllOpenTrips(events)) {
    const row = ensure(t.vehicle_id);
    if (!row) continue;
    row.has_open_trip = true;
    if (!row.open_trips.includes(t.trip)) row.open_trips.push(t.trip);
    row.driver_id = t.driver_id || row.driver_id;
    if (t.shift && !row.shift_id) row.shift_id = t.shift;
  }

  for (const p of publicVehicles || []) {
    const row = ensure(p.vehicle || p.vehicle_id);
    if (!row) continue;
    row.public_live = true;
    if (p.last_gps && (!row.last_gps_at || new Date(p.last_gps) > new Date(row.last_gps_at))) row.last_gps_at = p.last_gps;
    if (p.lat != null && p.lng != null) {
      row.map_lat = Number(p.lat);
      row.map_lng = Number(p.lng);
    }
    if (p.trip) row.focus_trip_id = p.trip;
  }

  const now = Date.now();
  const result = [];
  for (const vid of Object.keys(byVehicle)) {
    const row = byVehicle[vid];
    const recentGps = row.last_gps_at && (now - new Date(row.last_gps_at).getTime() < STALE_MS);
    const recentHb = row.last_heartbeat_at && (now - new Date(row.last_heartbeat_at).getTime() < STALE_MS);
    const stale = isOperativeStale(row.last_gps_at || row.last_heartbeat_at, row.shift_meta);
    const include = row.has_shift || row.has_open_trip || row.public_live || recentGps || recentHb || stale;
    if (!include) continue;
    row.status = deriveOperativeStatus(row);
    result.push(row);
  }
  return result.sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id));
}

function rowButtons(row) {
  const hasMapPos = row.map_lat != null && row.map_lng != null;
  return {
    pozicio: { rendered: true, enabled: true, works: hasMapPos },
    release: { rendered: true, enabled: !!row.has_shift },
    closeTrip: { rendered: true, enabled: !!row.has_open_trip },
    cleanup: { rendered: true, enabled: !!(row.has_shift || row.has_open_trip) },
  };
}

function allRequiredOps(row) {
  const b = rowButtons(row);
  // "minden szükséges művelet" = release ha shift, close ha trip, cleanup ha bármelyik, pozíció ha van coords
  const needs = [];
  if (row.has_shift) needs.push('release');
  if (row.has_open_trip) needs.push('closeTrip');
  if (row.has_shift || row.has_open_trip) needs.push('cleanup');
  if (row.map_lat != null) needs.push('pozicio');
  const missing = needs.filter((k) => !b[k]?.enabled && k !== 'pozicio' ? true : k === 'pozicio' && !b.pozicio.works);
  return { needs, missing, allOk: missing.length === 0 };
}

const events = allEvents();
const drivers = activeDriversFromDb();
const publicVehicles = publicVehiclesFromEvents(events);
const openTrips = collectAllOpenTrips(events);
const operativeRows = buildOperativeVehicleRows(events, drivers, publicVehicles);
const operativeSet = new Set(operativeRows.map((r) => r.vehicle_id));

const driverVehicles = new Set(drivers.map((d) => norm(d.vehicle_id)));
const publicSet = new Set(publicVehicles.map((p) => norm(p.vehicle || p.vehicle_id)));
const openTripVehicles = new Set(openTrips.map((t) => norm(t.vehicle_id)).filter(Boolean));

const stuckLock = operativeRows.filter((r) => r.status === 'BERAGADT_LOCK').map((r) => r.vehicle_id);
const stuckTrip = operativeRows.filter((r) => r.status === 'BERAGADT_TRIP').map((r) => r.vehicle_id);

console.log('=== OPERATÍV BLOKK LEFEDETTSÉG AUDIT ===\n');
console.log('Időpont:', new Date().toISOString());
console.log('Operatív sorok száma:', operativeRows.length);
console.log('Public live járművek:', [...publicSet].join(', ') || '(nincs)');
console.log('Nyitott shift járművek:', [...driverVehicles].join(', ') || '(nincs)');
console.log('Nyitott trip járművek:', [...openTripVehicles].join(', ') || '(nincs)');
console.log('Beragadt lock:', stuckLock.join(', ') || '(nincs)');
console.log('Beragadt trip:', stuckTrip.join(', ') || '(nincs)');
console.log('');

// Q1: minden problémás megjelenik?
const problematic = new Set([...publicSet, ...driverVehicles, ...openTripVehicles, ...stuckLock, ...stuckTrip]);
const q1Missing = [...problematic].filter((v) => !operativeSet.has(v));
console.log('1. Minden problémás jármű az Operatív blokkban?');
console.log('   Elvárás:', [...problematic].sort().join(', ') || '(nincs)');
console.log('   Operatív:', operativeRows.map((r) => r.vehicle_id).sort().join(', ') || '(nincs)');
console.log('   Hiányzó:', q1Missing.join(', ') || '(nincs)');
console.log('   Eredmény:', q1Missing.length === 0 ? 'PASS' : 'FAIL');
console.log('');

// Q2: public látható de nincs operatív blokkban
const q2Missing = [...publicSet].filter((v) => !operativeSet.has(v));
console.log('2. Public látható DE nincs Operatív blokkban');
console.log('   Érintett:', q2Missing.join(', ') || '(nincs)');
console.log('   Eredmény:', q2Missing.length === 0 ? 'PASS' : 'FAIL');
console.log('');

// Q3: nyitott shift de nincs operatív blokkban
const q3Missing = [...driverVehicles].filter((v) => !operativeSet.has(v));
console.log('3. Nyitott active_shift DE nincs Operatív blokkban');
console.log('   Érintett:', q3Missing.join(', ') || '(nincs)');
console.log('   Eredmény:', q3Missing.length === 0 ? 'PASS' : 'FAIL');
console.log('');

// Q4: minden problémás járműnél elérhető mind a 4 művelet
console.log('4. Minden művelet minden problémás járműnél');
let q4Fail = [];
for (const row of operativeRows) {
  const b = rowButtons(row);
  const ops = allRequiredOps(row);
  const isProblematic = row.has_shift || row.has_open_trip || row.public_live || ['BERAGADT_LOCK', 'BERAGADT_TRIP', 'STALE'].includes(row.status);
  if (!isProblematic) continue;
  if (!ops.allOk) q4Fail.push({ vid: row.vehicle_id, status: row.status, missing: ops.missing, buttons: b });
  console.log(`   ${row.vehicle_id} [${row.status}] shift=${row.has_shift} trip=${row.has_open_trip} public=${row.public_live}`);
  console.log(`     Pozíció: ${b.pozicio.works ? 'működik' : 'nincs koordináta'} | Release: ${b.release.enabled ? 'OK' : 'DISABLED'} | Close-trip: ${b.closeTrip.enabled ? 'OK' : 'DISABLED'} | Cleanup: ${b.cleanup.enabled ? 'OK' : 'DISABLED'}`);
}
console.log('   Eredmény:', q4Fail.length === 0 ? 'PASS' : 'FAIL', q4Fail.length ? JSON.stringify(q4Fail) : '');
console.log('');

// Q5: KV01 KV04
console.log('5. KV01 / KV04 – egy sorból minden szükséges művelet');
for (const vid of ['KV01', 'KV04']) {
  const row = operativeRows.find((r) => r.vehicle_id === vid);
  if (!row) {
    console.log(`   ${vid}: NINCS az operatív blokkban`);
    continue;
  }
  const b = rowButtons(row);
  const ops = allRequiredOps(row);
  console.log(`   ${vid}: status=${row.status} shift=${row.has_shift} trip=${row.has_open_trip} public=${row.public_live}`);
  console.log(`     open_trips: ${row.open_trips.join(', ') || '—'}`);
  console.log(`     Pozíció(${b.pozicio.works ? 'OK' : 'nincs GPS'}) Release(${b.release.enabled ? 'OK' : 'DISABLED'}) Close(${b.closeTrip.enabled ? 'OK' : 'DISABLED'}) Cleanup(${b.cleanup.enabled ? 'OK' : 'DISABLED'})`);
  console.log(`     Egy sorból teljes kezelés: ${ops.allOk ? 'PASS' : 'FAIL'} hiány: ${ops.missing.join(', ') || '—'}`);
}
console.log('');

// Inclusion edge case: public without shift/trip but stale only
const allCandidates = {};
for (const d of drivers) ensureCand(allCandidates, d.vehicle_id);
for (const t of openTrips) ensureCand(allCandidates, t.vehicle_id);
for (const p of publicVehicles) ensureCand(allCandidates, p.vehicle || p.vehicle_id);

function ensureCand(obj, id) {
  const v = norm(id);
  if (v) obj[v] = true;
}

// Q6 recommendation
const fullCoverage = q1Missing.length === 0 && q2Missing.length === 0 && q3Missing.length === 0;
console.log('6. JAVASLAT – Operatív blokk mint hivatalos hibakezelés');
console.log('   Lefedettség (megjelenés):', fullCoverage ? 'TELJES' : 'RÉSIKES');
console.log('   Műveleti teljesség (Q4):', q4Fail.length === 0 ? 'TELJES' : 'RÉSIKES');
if (fullCoverage && q4Fail.length === 0) {
  console.log('   → AKTÍV + MŰSZAKOK információs nézetként hagyható; Operatív blokk = hivatalos hibakezelés. MÁR MOST TELJESÜL.');
} else if (fullCoverage && q4Fail.length > 0) {
  console.log('   → Megjelenés teljes, de egyes műveletek DISABLED állapotban. Operatív blokk központ lehet, de nem minden gomb használható minden soron.');
} else {
  console.log('   → Még NEM teljesül teljes lefedettség. Operatív blokk nem lehet egyedüli hivatalos felület.');
}

// Detailed operative table
console.log('\n=== OPERATÍV SOROK RÉSZLET ===');
for (const r of operativeRows) {
  console.log(JSON.stringify({
    vehicle_id: r.vehicle_id,
    status: r.status,
    has_shift: r.has_shift,
    has_open_trip: r.has_open_trip,
    public_live: r.public_live,
    open_trips: r.open_trips,
    map: r.map_lat != null,
  }));
}

db.close();
