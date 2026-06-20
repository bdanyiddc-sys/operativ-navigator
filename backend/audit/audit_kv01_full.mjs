/**
 * KV01 teljes lánc – konkrét nyitott rekordok
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));
const BASE = 'http://localhost:3000';
const VID = 'KV01';

const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);
const SHIFT_START = new Set(['muszak_inditas', 'shift_start']);
const SHIFT_END = new Set(['shift_end', 'muszak_zaras']);
const GPS_TYPES = new Set(['gps', 'track', 'auto_track']);

function allEvents() {
  return db.prepare('SELECT * FROM events ORDER BY timestamp').all().map((r) => {
    let p = {};
    try {
      p = JSON.parse(r.payload_json || '{}');
    } catch {}
    return { ...r, payload: p };
  });
}

function vehicleId(e) {
  const p = e.payload || {};
  return String(p.vehicle_id || p.vehicle || '').toUpperCase();
}

const events = allEvents();
const kv01 = events.filter(
  (e) =>
    vehicleId(e) === VID ||
    String(e.trip || '').toUpperCase().includes(VID) ||
    String(e.shift || '').toUpperCase().includes(VID)
);

console.log('=== 1. KV01 nyitott események ===\n');

const openTrips = {};
const openShifts = {};
for (const e of events) {
  const trip = e.trip ? String(e.trip).trim() : '';
  const shift = e.shift ? String(e.shift).trim() : '';
  if (trip && TRIP_START.has(e.type)) openTrips[trip] = { start: e, end: null };
  if (trip && TRIP_END.has(e.type) && openTrips[trip]) openTrips[trip].end = e;
  if (shift && SHIFT_START.has(e.type)) openShifts[shift] = { start: e, end: null };
  if (shift && SHIFT_END.has(e.type) && openShifts[shift]) openShifts[shift].end = e;
}

const kv01OpenTrips = Object.entries(openTrips)
  .filter(([, v]) => !v.end)
  .filter(([trip, v]) => vehicleId(v.start) === VID || trip.toUpperCase().includes(VID));

console.log('trip_start / nyitott trip:');
if (!kv01OpenTrips.length) console.log('(nincs)');
kv01OpenTrips.forEach(([trip, v]) => {
  console.log(
    JSON.stringify({
      type: v.start.type,
      id: v.start.id,
      trip,
      shift: v.start.shift,
      ts: v.start.timestamp,
    })
  );
});

console.log('\ntrip_end: (nyitott triphez nincs lezáró)\n');

const kv01OpenShifts = Object.entries(openShifts)
  .filter(([, v]) => !v.end)
  .filter(([shift]) => shift.toUpperCase().includes(VID));

console.log('shift_start / nyitott shift:');
if (!kv01OpenShifts.length) console.log('(nincs)');
kv01OpenShifts.forEach(([shift, v]) => {
  console.log(
    JSON.stringify({
      type: v.start.type,
      id: v.start.id,
      shift,
      trip: v.start.trip,
      ts: v.start.timestamp,
    })
  );
});

console.log('\nshift_end: (nyitott shifthoz nincs lezáró)\n');

console.log('passenger (KV01, nyitott triphez):');
for (const [trip] of kv01OpenTrips) {
  const pax = kv01.filter((e) => e.type === 'passenger' && e.trip === trip);
  pax.slice(-3).forEach((e) =>
    console.log(JSON.stringify({ id: e.id, trip: e.trip, ts: e.timestamp, payload: e.payload }))
  );
}
if (!kv01OpenTrips.length) console.log('(nincs nyitott trip)');

console.log('\ngps (KV01, nyitott triphez):');
for (const [trip] of kv01OpenTrips) {
  kv01
    .filter((e) => GPS_TYPES.has(e.type) && e.trip === trip)
    .slice(-3)
    .forEach((e) =>
      console.log(
        JSON.stringify({
          id: e.id,
          type: e.type,
          trip: e.trip,
          ts: e.timestamp,
          lat: e.lat,
          lng: e.lng,
        })
      )
    );
}
if (!kv01OpenTrips.length) console.log('(nincs nyitott trip)');

console.log('\n=== 2. active_shifts KV01 (összes sor) ===');
const shifts = db.prepare('SELECT * FROM active_shifts WHERE vehicle_id = ? ORDER BY started_at').all(VID);
if (!shifts.length) console.log('(nincs sor)');
shifts.forEach((s) =>
  console.log(
    JSON.stringify({
      shift_id: s.shift_id,
      status: s.status,
      started_at: s.started_at,
      closed_at: s.closed_at,
    })
  )
);

console.log('\n=== 3. /api/admin/open-trips KV01 ===');
console.log('\n=== 4. /api/vehicle-positions KV01 ===');

try {
  const [openTripsApi, positions] = await Promise.all([
    fetch(BASE + '/api/admin/open-trips').then((r) => r.json()),
    fetch(BASE + '/api/vehicle-positions').then((r) => r.json()),
  ]);
  const ot = (openTripsApi.trips || []).filter((t) => String(t.vehicle_id).toUpperCase() === VID);
  const vp = (positions.vehicles || []).filter((v) => String(v.vehicle).toUpperCase() === VID);
  console.log(JSON.stringify(ot, null, 2) || '(nincs)');
  console.log(JSON.stringify(vp, null, 2) || '(nincs)');

  console.log('\n=== 5. Miért látszik KV01? ===');
  if (vp.length) {
    console.log('A) nyitott trip miatt');
    console.log('trip:', vp[0].trip);
  } else if (ot.length) {
    console.log('A) nyitott trip miatt');
    console.log('trip:', ot[0].trip);
  } else if (kv01OpenShifts.length) {
    console.log('B) nyitott shift miatt (events – public NEM shift alapján)');
  } else {
    console.log('KV01 jelenleg NINCS a public /vehicle-positions listán');
  }

  console.log('\n=== 6. Lezárás ===');
  if (ot.length) {
    console.log(
      'POST /api/admin/vehicles/KV01/close-trip body: { trip: "' +
        ot[0].trip +
        '" }  (trip id: ' +
        ot[0].trip +
        ')'
    );
  } else if (kv01OpenTrips.length) {
    const [trip, v] = kv01OpenTrips[0];
    console.log('trip_end kell: trip="' + trip + '" start_id=' + v.start.id);
  } else if (kv01OpenShifts.length) {
    const [shift, v] = kv01OpenShifts[0];
    console.log('shift_end kell: shift="' + shift + '" start_id=' + v.start.id);
  } else {
    console.log('Nincs lezárandó rekord – KV01 már nincs publicon.');
  }
} catch (e) {
  console.log('API hiba:', e.message);
}

db.close();
