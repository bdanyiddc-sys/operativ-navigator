/**
 * KV01/KV04 visibility audit
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));

const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);
const VEHICLES = ['KV01', 'KV04'];

function allEvents() {
  return db.prepare('SELECT * FROM events ORDER BY timestamp').all().map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload_json || '{}'); } catch {}
    return { ...r, payload: p, vehicle_id: p.vehicle_id || r.vehicle_id };
  });
}

function openTrips(events) {
  const open = new Map();
  for (const ev of events) {
    const trip = ev.trip ? String(ev.trip).trim() : '';
    if (!trip) continue;
    if (TRIP_START.has(ev.type)) {
      open.set(trip, {
        trip,
        vehicle_id: ev.vehicle_id || ev.payload?.vehicle_id,
        shift: ev.shift || ev.payload?.shift,
        started: ev.timestamp,
      });
    }
    if (TRIP_END.has(ev.type)) open.delete(trip);
  }
  return open;
}

function publicLiveVehicles(events) {
  const open = openTrips(events);
  const live = new Map();
  for (const [trip, meta] of open) {
    const track = db.prepare(
      "SELECT lat,lng,timestamp FROM events WHERE trip=? AND type IN ('track','auto_track') AND lat IS NOT NULL ORDER BY timestamp DESC LIMIT 1"
    ).get(trip);
    if (!track) continue;
    const vid = String(meta.vehicle_id || '').toUpperCase();
    if (!vid) continue;
    live.set(vid, {
      vehicle: vid,
      trip,
      lat: track.lat,
      lng: track.lng,
      last_gps: track.timestamp,
      live: true,
    });
  }
  return live;
}

function openShifts() {
  return db.prepare('SELECT * FROM active_shifts WHERE closed_at IS NULL').all();
}

const events = allEvents();
const open = openTrips(events);
const live = publicLiveVehicles(events);
const shifts = openShifts();

console.log('=== KV01 / KV04 VISIBILITY ===\n');

for (const vid of VEHICLES) {
  const trips = [...open.values()].filter((t) => String(t.vehicle_id || '').toUpperCase() === vid);
  const pub = live.get(vid);
  const shiftRows = shifts.filter((s) => String(s.vehicle_id).toUpperCase() === vid);

  const adminJaratok = trips.length > 0;
  const adminAktiv = trips.length > 0;
  const adminMuszakok = shiftRows.length > 0;
  const felszabadithatoMuszak = adminMuszakok;
  const felszabadithatoReleaseBtn = adminMuszakok;

  console.log(vid);
  console.log('  Public live:', pub ? 'IGEN' : 'NEM', pub || '');
  console.log('  Open trips:', trips.map((t) => t.trip).join(', ') || '(nincs)');
  console.log('  active_shifts open:', shiftRows.length, shiftRows.map((s) => s.shift_id).join(', ') || '');
  console.log('  Admin JÁRATOK/AKTÍV:', adminJaratok ? 'IGEN' : 'NEM');
  console.log('  Admin MŰSZAKOK:', adminMuszakok ? 'IGEN' : 'NEM');
  console.log('  Release (active_shifts):', felszabadithatoReleaseBtn ? 'IGEN ha MŰSZAKOK tab' : 'NEM');
  console.log('  Close-trip (events):', adminJaratok ? 'IGEN ha van shift_id match' : 'NEM');
  console.log('');
}

console.log('=== DESYNC CASES ===');
for (const [vid, row] of live) {
  const shiftRows = shifts.filter((s) => String(s.vehicle_id).toUpperCase() === vid);
  const trips = [...open.values()].filter((t) => String(t.vehicle_id || '').toUpperCase() === vid);
  const anyAdmin = trips.length > 0 || shiftRows.length > 0;
  const releaseOk = shiftRows.length > 0;
  console.log(vid, 'public=YES', 'admin_any_list=', anyAdmin, 'release_via_shifts=', releaseOk);
}

const orphanPublic = [...live.keys()].filter((vid) => {
  const shiftRows = shifts.filter((s) => String(s.vehicle_id).toUpperCase() === vid);
  return shiftRows.length === 0;
});

console.log('\nPublic YES but NO active_shifts (release gomb csak lockra):', orphanPublic.length, orphanPublic);
console.log('Operátori elvesző (public YES, admin MŰSZAKOK NEM, trip lehet IGEN):',
  [...live.keys()].filter((vid) => {
    const shiftRows = shifts.filter((s) => String(s.vehicle_id).toUpperCase() === vid);
    return shiftRows.length === 0;
  }).length);

db.close();
