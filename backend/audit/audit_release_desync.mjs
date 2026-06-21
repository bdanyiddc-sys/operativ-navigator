/**
 * DESYNC audit – release utáni állapot (read-only snapshot + szimuláció)
 * node audit_release_desync.mjs
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));

const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);
const VEHICLE = 'KV01';

function openTripsForVehicle(vehicleId) {
  const rows = db.prepare('SELECT id, type, trip, shift, timestamp, payload_json FROM events ORDER BY timestamp').all();
  const open = new Map();
  for (const r of rows) {
    const trip = r.trip ? String(r.trip).trim() : '';
    if (!trip) continue;
    if (TRIP_START.has(r.type)) {
      let p = {};
      try { p = JSON.parse(r.payload_json || '{}'); } catch {}
      open.set(trip, {
        trip,
        trip_start_ts: r.timestamp,
        trip_start_type: r.type,
        vehicle_id: p.vehicle_id || null,
        shift: r.shift || p.shift || null,
      });
    }
    if (TRIP_END.has(r.type)) open.delete(trip);
  }
  return [...open.values()].filter((t) => String(t.vehicle_id || '').toUpperCase() === vehicleId.toUpperCase());
}

function activeShifts(vehicleId) {
  return db.prepare(
    'SELECT shift_id, vehicle_id, driver_id, status, started_at, last_gps_at, last_heartbeat_at, closed_at FROM active_shifts WHERE vehicle_id = ?'
  ).all(vehicleId);
}

function openShifts(vehicleId) {
  return activeShifts(vehicleId).filter((r) => !r.closed_at);
}

function countEventsForVehicle(vehicleId) {
  const rows = db.prepare('SELECT type, COUNT(*) as c FROM events WHERE payload_json LIKE ? GROUP BY type').all('%"vehicle_id":"' + vehicleId + '"%');
  const alt = db.prepare('SELECT type, COUNT(*) as c FROM events WHERE payload_json LIKE ? GROUP BY type').all('%"vehicle_id": "' + vehicleId + '"%');
  return { pattern1: rows, pattern2: alt };
}

function publicWouldShow(vehicleId) {
  const trips = openTripsForVehicle(vehicleId);
  const positions = [];
  for (const t of trips) {
    const track = db.prepare(
      'SELECT timestamp, lat, lng FROM events WHERE trip = ? AND type IN (\'track\',\'auto_track\') AND lat IS NOT NULL ORDER BY timestamp DESC LIMIT 1'
    ).get(t.trip);
    if (track) {
      positions.push({ trip: t.trip, last_gps: track.timestamp, lat: track.lat, lng: track.lng, live: true });
    }
  }
  return { open_trips: trips.length, with_gps: positions.length, details: positions };
}

function driverLoginBlocked(vehicleId) {
  return openShifts(vehicleId).length > 0;
}

console.log('=== KV01 RELEASE DESYNC AUDIT ===\n');

const beforeOpenShifts = openShifts(VEHICLE);
const beforeAllShifts = activeShifts(VEHICLE);
const beforeTrips = openTripsForVehicle(VEHICLE);
const beforePublic = publicWouldShow(VEHICLE);
const beforeLogin = driverLoginBlocked(VEHICLE);

console.log('--- RELEASE ELŐTT ---');
console.log('active_shifts nyitott:', JSON.stringify(beforeOpenShifts, null, 2));
console.log('nyitott trip_start (KV01):', JSON.stringify(beforeTrips, null, 2));
console.log('public élő lenne:', JSON.stringify(beforePublic, null, 2));
console.log('sofőr belépés tiltva:', beforeLogin);

console.log('\n--- releaseVehicleLock() MIT CSINÁL (kód) ---');
console.log('UPDATE active_shifts SET status=CLOSED, closed_at=NOW WHERE vehicle_id=KV01 AND closed_at IS NULL');
console.log('events tábla: NEM módosul');
console.log('trip_start / trip_end: NEM módosul');

console.log('\n--- RELEASE UTÁN (szimulált logika) ---');
const afterOpenShifts = [];
const afterTrips = beforeTrips;
const afterPublic = beforePublic;
const afterLogin = false;

console.log('active_shifts nyitott:', afterOpenShifts.length ? afterOpenShifts : '(0 sor – closed_at kitöltve)');
console.log('events sorok száma: változatlan');
console.log('nyitott trip_start (KV01):', JSON.stringify(afterTrips, null, 2));
console.log('trip_end új sor: NEM');
console.log('public élő lenne:', JSON.stringify(afterPublic, null, 2));
console.log('sofőr belépés tiltva:', afterLogin);

console.log('\n--- TÁBLÁZAT ---');
const rows = [
  ['active_shifts (nyitott KV01)', beforeOpenShifts.length + ' sor', '0 sor (closed_at kitöltve)'],
  ['events (sorok száma)', 'változatlan', 'változatlan'],
  ['trip_start (nyitott KV01)', beforeTrips.length ? beforeTrips.map(t => t.trip).join(', ') : '0', 'ugyanaz – nem záródik'],
  ['trip_end', '—', 'release nem ír újat'],
  ['public térkép (/api/vehicle-positions)', beforePublic.with_gps ? 'IGEN (nyitott trip + GPS)' : 'NEM', beforePublic.with_gps ? 'IGEN (DESYNC)' : 'NEM'],
  ['admin JÁRATOK tab', beforeTrips.length ? 'IGEN (events nyitott trip)' : 'NEM', beforeTrips.length ? 'IGEN' : 'NEM'],
  ['admin AKTÍV tab', beforeTrips.length ? 'IGEN' : 'NEM', beforeTrips.length ? 'IGEN' : 'NEM'],
  ['admin MŰSZAKOK tab', beforeOpenShifts.length ? 'IGEN' : 'NEM', 'NEM'],
  ['sofőr belépés (POST /api/shifts/start)', beforeLogin ? 'TILTVA (409)' : 'ENGEDÉLYEZETT', 'ENGEDÉLYEZETT'],
];
console.log('Állapot | Release előtt | Release után');
rows.forEach((r) => console.log(r.join(' | ')));

const desync = beforePublic.with_gps > 0 && !afterLogin;
console.log('\n--- DESYNC PASS/FAIL ---');
console.log(desync
  ? 'FAIL – release sikeres, de public továbbra is élő vonatként mutathatja KV01-et (nyitott trip_start + régi GPS marad)'
  : 'PASS – nincs nyitott trip/GPS, release után nincs public desync');

console.log('\n--- trip_start LEZÁRÁS endpointok ---');
console.log('1. POST /api/admin/active-shifts/:shiftId/close-trip  → insert trip_end esemény');
console.log('2. Sofőr: trip_end / jarat_zaras esemény POST /api/events-en keresztül');
console.log('3. POST /api/admin/active-shifts/:shiftId/close → shift_end (NEM trip_end)');
console.log('4. POST /api/admin/vehicles/:vehicleId/release → CSAK active_shifts (NEM trip_end)');

db.close();
