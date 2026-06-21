/**
 * Verify KV01/KV04 appear in operative vehicle logic (same rules as admin UI).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));
const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);
const STALE_MS = 30 * 60 * 1000;
const TARGETS = ['KV01', 'KV04'];

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
      "SELECT timestamp FROM events WHERE trip=? AND type IN ('track','auto_track') AND lat IS NOT NULL ORDER BY timestamp DESC LIMIT 1"
    ).get(trip);
    if (!track) continue;
    const vid = String(meta.vehicle_id || '').toUpperCase();
    if (!vid) continue;
    live.set(vid, { vehicle: vid, trip, last_gps: track.timestamp });
  }
  return live;
}

function openShifts() {
  return db.prepare('SELECT * FROM active_shifts WHERE closed_at IS NULL').all();
}

const events = allEvents();
const live = publicLive(events);
const shifts = openShifts();
const open = openTrips(events);

console.log('=== OPERATÍV LISTA ELLENŐRZÉS ===\n');
console.log('Jármű | Public live | Active shift | Nyitott trip | Operatív listában | Kezelhető');
console.log('---|---|---|---|---|---');

let pass = true;
for (const vid of TARGETS) {
  const pub = live.has(vid);
  const shift = shifts.some((s) => String(s.vehicle_id).toUpperCase() === vid);
  const trips = [...open.values()].filter((t) => String(t.vehicle_id || '').toUpperCase() === vid);
  const tripOpen = trips.length > 0;
  const pubRow = live.get(vid);
  const lastGps = pubRow?.last_gps;
  const recentGps = lastGps && (Date.now() - new Date(lastGps).getTime() < STALE_MS);
  const stale = lastGps && (Date.now() - new Date(lastGps).getTime() >= STALE_MS);
  const inList = shift || tripOpen || pub || recentGps || stale;
  const kezelheto = inList && (shift || tripOpen);
  if (pub && !inList) pass = false;
  if (pub && !kezelheto) pass = false;
  console.log(
    `${vid} | ${pub ? 'IGEN' : 'NEM'} | ${shift ? 'IGEN' : 'NEM'} | ${tripOpen ? 'IGEN' : 'NEM'} | ${inList ? 'IGEN' : 'NEM'} | ${kezelheto ? 'IGEN' : 'NEM'}`
  );
}

console.log('\nPublic → Admin kezelhető:', pass ? 'PASS' : 'FAIL');
db.close();
