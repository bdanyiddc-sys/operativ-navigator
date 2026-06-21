/**
 * Default admin UI visibility (JÁRATOK tab + Ma filter + map)
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));
const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);
const TODAY = '2026-06-20';

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
      open.set(trip, { trip, vehicle_id: ev.vehicle_id || ev.payload?.vehicle_id });
    }
    if (TRIP_END.has(ev.type)) open.delete(trip);
  }
  return open;
}

function publicLive(events) {
  const open = openTrips(events);
  const live = new Map();
  for (const [trip, meta] of open) {
    const track = db.prepare(
      "SELECT lat,lng,timestamp FROM events WHERE trip=? AND type IN ('track','auto_track') AND lat IS NOT NULL ORDER BY timestamp DESC LIMIT 1"
    ).get(trip);
    if (!track) continue;
    const vid = String(meta.vehicle_id || '').toUpperCase();
    if (!vid) continue;
    live.set(vid, { vehicle: vid, trip, lat: track.lat, lng: track.lng, last_gps: track.timestamp });
  }
  return live;
}

function parseTripDay(tripId) {
  const m = String(tripId).match(/_(\d{6})$/);
  if (!m) return null;
  const s = m[1];
  return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
}

const events = allEvents();
const open = openTrips(events);
const live = publicLive(events);
const shifts = db.prepare('SELECT * FROM active_shifts WHERE closed_at IS NULL').all();

console.log('=== DEFAULT UI (JÁRATOK + Ma=' + TODAY + ', térkép ugyanazzal a szűrővel) ===\n');

let hiddenOnDefault = 0;
let noReleasePath = 0;

for (const [vid, pub] of live) {
  const trips = [...open.values()].filter((t) => String(t.vehicle_id || '').toUpperCase() === vid);
  const shiftRows = shifts.filter((s) => String(s.vehicle_id).toUpperCase() === vid);
  const jaratokMa = trips.some((t) => parseTripDay(t.trip) === TODAY);
  const aktiv = trips.length > 0;
  const muszakok = shiftRows.length > 0;
  if (!jaratokMa) hiddenOnDefault++;
  if (!muszakok) noReleasePath++;

  console.log(vid, {
    public_trip: pub.trip,
    jaratok_ma: jaratokMa,
    aktiv_tab: aktiv,
    muszakok_tab: muszakok,
    map_ma: jaratokMa,
    release_muszakok: muszakok,
  });
}

console.log('\nPublic live összesen:', live.size);
console.log('Default nézetben (JÁRATOK+Ma+térkép) rejtett:', hiddenOnDefault);
console.log('Nincs MŰSZAKOK sor (frontend release gomb):', noReleasePath);
console.log('Operátori elvesző (public IGEN, default+AKTÍV+MŰSZAKOK mind NEM):',
  [...live.keys()].filter((vid) => {
    const trips = [...open.values()].filter((t) => String(t.vehicle_id || '').toUpperCase() === vid);
    const shiftRows = shifts.filter((s) => String(s.vehicle_id).toUpperCase() === vid);
    return trips.length === 0 && shiftRows.length === 0;
  }).length);

db.close();
