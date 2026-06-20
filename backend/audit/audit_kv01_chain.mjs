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

function allEvents() {
  return db.prepare('SELECT * FROM events ORDER BY timestamp').all().map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload_json || '{}'); } catch {}
    return { ...r, payload: p };
  });
}

const events = allEvents();
const kv01Events = events.filter((e) => {
  const p = e.payload || {};
  return String(p.vehicle_id || e.vehicle_id || '').toUpperCase() === VID
    || String(e.trip || '').includes('KV01')
    || String(e.shift || '').includes('KV01');
});

console.log('=== 1. KV01 EVENTS (open state) ===');
const openTrips = {};
const openShifts = {};
for (const e of events) {
  const trip = e.trip;
  const shift = e.shift;
  if (trip && TRIP_START.has(e.type)) openTrips[trip] = { start: e, end: null };
  if (trip && TRIP_END.has(e.type) && openTrips[trip]) openTrips[trip].end = e;
  if (shift && SHIFT_START.has(e.type)) openShifts[shift] = { start: e, end: null };
  if (shift && SHIFT_END.has(e.type) && openShifts[shift]) openShifts[shift].end = e;
}

console.log('\nNyitott trip(ek):');
Object.entries(openTrips).filter(([, v]) => !v.end).forEach(([trip, v]) => {
  console.log(JSON.stringify({ trip, start_id: v.start.id, start_ts: v.start.timestamp, shift: v.start.shift, type: v.start.type }));
});

console.log('\nNyitott shift(ek) events alapján:');
Object.entries(openShifts).filter(([, v]) => !v.end).forEach(([shift, v]) => {
  console.log(JSON.stringify({ shift, start_id: v.start.id, start_ts: v.start.timestamp, type: v.start.type }));
});

console.log('\n=== 2. active_shifts KV01 ===');
const shifts = db.prepare('SELECT * FROM active_shifts WHERE vehicle_id = ?').all(VID);
shifts.forEach((s) => console.log(JSON.stringify({ shift_id: s.shift_id, status: s.status, closed_at: s.closed_at, started_at: s.started_at })));

console.log('\n=== 3-4. API ===');
try {
  const [openTripsApi, positions] = await Promise.all([
    fetch(BASE + '/api/admin/open-trips').then((r) => r.json()),
    fetch(BASE + '/api/vehicle-positions').then((r) => r.json()),
  ]);
  console.log('open-trips KV01:', JSON.stringify((openTripsApi.trips || []).filter((t) => String(t.vehicle_id).toUpperCase() === VID)));
  console.log('vehicle-positions KV01:', JSON.stringify((positions.vehicles || []).filter((v) => v.vehicle === VID)));
} catch (e) {
  console.log('API error:', e.message);
}

db.close();
