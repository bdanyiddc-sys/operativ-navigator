import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB = path.resolve('data/events.db');
const db = new Database(DB, { readonly: true });

const START_TYPES = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const END_TYPES = new Set(['trip_end', 'jarat_zaras']);

function payload(row) {
  try { return JSON.parse(row.payload_json); } catch { return {}; }
}

function auditTrip(tripPattern) {
  const rows = db.prepare(`
    SELECT id, type, trip, shift, timestamp, created_at, payload_json
    FROM events
    WHERE trip LIKE ?
    ORDER BY created_at ASC
  `).all(tripPattern + '%');

  const starts = rows.filter((r) => START_TYPES.has(r.type));
  const ends = rows.filter((r) => END_TYPES.has(r.type));
  const start = starts[0] || null;
  const end = ends[ends.length - 1] || null;
  const p = start ? payload(start) : (rows[0] ? payload(rows[0]) : {});

  return {
    trip_id: start?.trip || rows.find((r) => r.trip)?.trip || tripPattern,
    vehicle_id: p.vehicle_id || null,
    driver_id: p.driver_id || null,
    trip_start_event_id: start?.id || null,
    trip_start_timestamp: start?.timestamp || null,
    trip_end_event_id: end?.id || null,
    trip_end_timestamp: end?.timestamp || null,
    STATUS: end ? 'LEZÁRT' : (start ? 'AKTÍV' : 'NINCS_ADAT'),
    event_count: rows.length,
  };
}

const targets = [
  'trip_KV11_2026-06-20T17-44-36',
  'trip_KV10_2026-06-20T17-44-18',
  'trip_KV10_2026-06-20T17-09-06',
  '17-51_Tata1_260620',
];

const table = targets.map(auditTrip);

// all today's trips from events
const allToday = db.prepare(`
  SELECT DISTINCT trip FROM events
  WHERE trip IS NOT NULL AND trip != ''
    AND (trip LIKE '%2026-06-20%' OR trip LIKE '%260620%')
  ORDER BY trip
`).all();

const todayAudit = allToday.map((r) => auditTrip(r.trip));

// open trips via API logic simulation
function activeTripIdsFromEvents(events) {
  const open = new Map();
  const sorted = events.slice().sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  sorted.forEach((ev) => {
    const trip = ev.trip != null ? String(ev.trip).trim() : '';
    if (!trip) return;
    const type = String(ev.type || '').trim();
    if (START_TYPES.has(type)) open.set(trip, true);
    if (END_TYPES.has(type)) open.delete(trip);
  });
  return open;
}

const allEvents = db.prepare('SELECT id, type, trip, timestamp, created_at FROM events ORDER BY created_at').all();
const openIds = activeTripIdsFromEvents(allEvents);
const openToday = [...openIds.keys()].filter((t) => t.includes('2026-06-20') || t.includes('260620'));

// test trip ids from reports
const reportFiles = [
  'test-output/operator_flow_patch_20260620_194418/report.json',
  'test-output/operator_flow_run2/report.json',
  'test-output/operator_flow_20260620_185938/report.json',
];
const testTrips = new Set();
reportFiles.forEach((f) => {
  try {
    const r = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
    if (r.tripId) testTrips.add(r.tripId);
    (r.steps || []).forEach((s) => {
      const te = s.db?.tripEnd?.trip;
      if (te) testTrips.add(te);
      const ot = s.api?.openTrips?.data?.trips?.[0]?.trip;
      if (ot) testTrips.add(ot);
      const ot2 = s.api?.openBeforeCleanup?.data?.trips?.[0]?.trip;
      if (ot2) testTrips.add(ot2);
    });
  } catch (_) {}
});

const openTripsApi = await fetch('http://127.0.0.1:3000/api/admin/open-trips').then((r) => r.json()).catch(() => ({ trips: [] }));
const adminTripsApi = await fetch('http://127.0.0.1:3000/api/admin/trips').then((r) => r.json()).catch(() => ({ trips: [] }));

const report = {
  verdict: table.every((r) => r.STATUS === 'LEZÁRT') ? 'PASS' : 'FAIL',
  targetTrips: table,
  allTodayTrips: todayAudit,
  openTripsToday: openToday,
  openTripsApiCount: openTripsApi.count,
  openTripsApi: openTripsApi.trips,
  adminTripsApiCount: adminTripsApi.count,
  testTripIdsFromReports: [...testTrips],
  targetFromTest: table.map((r) => ({
    trip_id: r.trip_id,
    fromOperatorFlowTest: [...testTrips].some((t) => r.trip_id.startsWith(t.slice(0, 30)) || t.startsWith(r.trip_id.slice(0, 30)) || testTrips.has(r.trip_id)),
  })),
};

console.log(JSON.stringify(report, null, 2));
db.close();
process.exit(report.verdict === 'PASS' ? 0 : 1);
