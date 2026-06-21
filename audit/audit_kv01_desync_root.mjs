/**
 * KV01 DESYNC ROOT CAUSE – read-only concrete proof
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'events.db'));
const BASE = 'http://localhost:3000';
const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);
const KV01_TRIP = '23-51_Tata1_260608';

const selectRecentEvents = db.prepare(`
  SELECT id, type, trip, shift, timestamp, lat, lng, payload_json, created_at
  FROM events ORDER BY timestamp DESC, created_at DESC LIMIT ?
`);
const selectEventsChronological = db.prepare(`
  SELECT id, type, trip, shift, timestamp, lat, lng, payload_json, created_at
  FROM events ORDER BY timestamp ASC, created_at ASC
`);
const totalEvents = db.prepare('SELECT COUNT(*) c FROM events').get().c;

function rowToClient(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch {}
  return { ...row, payload, type: row.type, trip: row.trip, shift: row.shift };
}

function activeTripIdsFromEvents(events) {
  const open = new Map();
  const sorted = [...events].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  for (const ev of sorted) {
    const trip = ev.trip ? String(ev.trip).trim() : '';
    if (!trip) continue;
    const type = String(ev.type || '').trim();
    if (TRIP_START.has(type)) open.set(trip, true);
    if (TRIP_END.has(type)) open.delete(trip);
  }
  return open;
}

function collectAllOpenTripsAdmin(events) {
  const open = {};
  const chrono = [...events].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  for (const ev of chrono) {
    const id = ev.trip || ev.payload?.trip;
    if (!id) continue;
    const t = String(ev.type || '').toLowerCase();
    if (TRIP_START.has(t)) {
      const p = ev.payload || {};
      open[id] = { trip: id, vehicle_id: p.vehicle_id || ev.vehicle_id, shift: ev.shift || p.shift, ts: ev.timestamp, evt_id: ev.id };
    }
    if (TRIP_END.has(t)) delete open[id];
  }
  return Object.values(open);
}

async function main() {
  const [pubRes, adminEventsRes] = await Promise.all([
    fetch(BASE + '/api/vehicle-positions'),
    fetch(BASE + '/api/events?limit=1500'),
  ]);
  const pub = await pubRes.json();
  const adminEvents = (await adminEventsRes.json()).events || [];

  const kv01Pub = (pub.vehicles || []).find((v) => String(v.vehicle).toUpperCase() === 'KV01');
  const allChrono = selectEventsChronological.all().map(rowToClient);
  const recent1500 = selectRecentEvents.all(1500).map(rowToClient);
  const adminLimit1500 = adminEvents;

  // KV01 trip_start full DB
  const tripStartFull = allChrono.filter((e) => e.trip === KV01_TRIP && TRIP_START.has(String(e.type)));
  const tripEndFull = allChrono.filter((e) => e.trip === KV01_TRIP && TRIP_END.has(String(e.type)));
  const inRecent1500 = recent1500.some((e) => e.trip === KV01_TRIP && TRIP_START.has(String(e.type)));
  const inAdminFetch = adminLimit1500.some((e) => e.trip === KV01_TRIP && TRIP_START.has(String(e.type)));

  const openFromFull = activeTripIdsFromEvents(allChrono);
  const openFromAdmin1500 = collectAllOpenTripsAdmin(adminLimit1500);
  const openFromPublicLogic = activeTripIdsFromEvents(allChrono); // buildVehiclePositions uses full scan

  const oldestRecent = recent1500[recent1500.length - 1];
  const tripStartRow = tripStartFull[0];

  console.log('========== KV01 DESYNC ROOT CAUSE ==========\n');

  console.log('## 1. PUBLIC API – miért lát nyitott tripet?\n');
  if (kv01Pub) {
    console.log('GET /api/vehicle-positions → KV01:');
    console.log('  trip id:', kv01Pub.trip);
    console.log('  last_gps:', kv01Pub.last_gps);
    console.log('  lat/lng:', kv01Pub.lat, kv01Pub.lng);
    console.log('  passengers:', kv01Pub.passengers);
  }
  console.log('\nLánc:');
  console.log('  Endpoint: app.get("/api/vehicle-positions") → server.js ~2564');
  console.log('  Track input: selectRecentEvents.all(limit) – utolsó', recent1500.length, 'rekord');
  console.log('  NYITOTT TRIP detektálás: buildVehiclePositionsFromEvents() → activeTripIdsFromEvents(allEvents)');
  console.log('  allEvents forrás: selectEventsChronological.all() – TELJES events tábla,', allChrono.length, 'rekord');
  console.log('  KV01 trip nyitott (full scan):', openFromFull.has(KV01_TRIP) ? 'IGEN' : 'NEM');
  if (tripStartRow) {
    console.log('\nForrás rekord (trip_start, teljes DB):');
    console.log('  id:', tripStartRow.id);
    console.log('  type:', tripStartRow.type);
    console.log('  trip:', tripStartRow.trip);
    console.log('  shift:', tripStartRow.shift);
    console.log('  timestamp:', tripStartRow.timestamp);
    console.log('  payload.vehicle_id:', tripStartRow.payload?.vehicle_id);
  }
  const lastTrack = recent1500.find((e) => e.trip === KV01_TRIP && (e.type === 'track' || e.type === 'auto_track'));
  const lastTrackAny = [...allChrono].reverse().find((e) => e.trip === KV01_TRIP && (e.type === 'track' || e.type === 'auto_track'));
  console.log('\nGPS megjelenítéshez használt track (recent ablakban):', lastTrack ? lastTrack.timestamp : 'NINCS a recent 1500-ben');
  console.log('GPS fallback (allEvents scan):', lastTrackAny ? lastTrackAny.timestamp : 'NINCS');

  console.log('\n## 2. OPERATÍV BLOKK – miért NEM lát nyitott tripet?\n');
  console.log('Lánc:');
  console.log('  refresh() → fetchJson("/api/events?limit=" + EVENT_FETCH_LIMIT)');
  console.log('  EVENT_FETCH_LIMIT = 1500 (frontend/admin/index.html ~3130)');
  console.log('  SQL: selectRecentEvents – ORDER BY timestamp DESC LIMIT 1500');
  console.log('  buildOperativeVehicleRows → collectAllOpenTrips(lastEvents)');
  console.log('\nAdmin által olvasott rekordok:', adminLimit1500.length, '(limit 1500)');
  console.log('Teljes events tábla:', totalEvents);
  console.log('Recent 1500 legrégebbi timestamp:', oldestRecent?.timestamp);
  console.log('KV01 trip_start timestamp:', tripStartRow?.timestamp);
  console.log('trip_start BENNE VAN a recent 1500-ben?', inRecent1500 ? 'IGEN' : 'NEM');
  console.log('trip_start BENNE VAN az admin fetch-ben?', inAdminFetch ? 'IGEN' : 'NEM');
  console.log('\n→ trip_start', tripStartRow?.timestamp, '<', oldestRecent?.timestamp, '→ KIESIK a recent ablakból');
  console.log('\ncollectAllOpenTrips(admin 1500) nyitott tripjei:', openFromAdmin1500.map((t) => t.trip + ' vid=' + t.vehicle_id).join(', ') || '(nincs KV01)');
  const kv01OpenAdmin = openFromAdmin1500.find((t) => String(t.vehicle_id || '').toUpperCase() === 'KV01');
  console.log('KV01 has_open_trip (admin logika):', !!kv01OpenAdmin, kv01OpenAdmin || '');

  console.log('\n## 3. Ugyanaz az adatforrás?\n');
  console.log('Public nyitott-trip: selectEventsChronological.all() – TELJES DB');
  console.log('Operatív nyitott-trip: selectRecentEvents LIMIT 1500 – RÉSZleges ablak');
  console.log('Eredmény: FAIL – NEM ugyanaz');

  console.log('\n## 4. Függvények\n');
  console.log('Public:  buildVehiclePositionsFromEvents() + activeTripIdsFromEvents(selectEventsChronological.all())');
  console.log('Operatív: collectAllOpenTrips(normalizeEvents(selectRecentEvents LIMIT 1500))');
  console.log('AKTÍV:   getActiveTripsCurrent(lastTrips, lastEvents) → splitTripsActiveArchived → hasTripEnded(lastEvents)');
  console.log('         lastEvents = ugyanaz 1500-es fetch');

  // AKTÍV tab check
  const aktivOpen = collectAllOpenTripsAdmin(adminLimit1500);
  const kv01Aktiv = aktivOpen.some((t) => String(t.vehicle_id || '').toUpperCase() === 'KV01');
  console.log('\nAKTÍV tab KV01 megjelenik?', kv01Aktiv ? 'IGEN' : 'NEM (nincs nyitott trip az 1500 ablakban)');

  console.log('\n## 5. MŰSZAKOK tab\n');
  const drivers = await fetch(BASE + '/api/admin/active-drivers').then((r) => r.json());
  const kv01Shifts = (drivers.drivers || []).filter((d) => String(d.vehicle_id).toUpperCase() === 'KV01');
  console.log('GET /api/admin/active-drivers → getActiveShiftsFromDb() VAGY getActiveDriverSessions()');
  console.log('getActiveDriverSessions: selectEventsChronological.all() – TELJES DB, muszak_inditas/shift_end');
  console.log('KV01 shift rekordok:', kv01Shifts.length);
  kv01Shifts.forEach((s) => console.log('  shift_id:', s.shift_id, 'started_at:', s.started_at));

  console.log('\n## 6. Operatív blokk – miért jelenik meg KV01?\n');
  console.log('include = has_shift || has_open_trip || public_live || recentGps || recentHb || stale');
  console.log('KV01: has_shift=true (active-drivers), public_live=true (vehicle-positions), has_open_trip=FALSE (1500 ablak)');

  console.log('\n## 7. close-trip disabled – konkrét változó\n');
  console.log('renderOperativeVehicleRowHtml: data-op-close-trips disabled ha !row.has_open_trip');
  console.log('row.has_open_trip =', !!kv01OpenAdmin, '(false, mert collectAllOpenTrips nem találja KV01 trip_start-ot)');

  console.log('\n## 8. Release / Cleanup close-trip disabled mellett\n');
  console.log('Release: POST /api/admin/vehicles/KV01/release → releaseVehicleLock()');
  console.log('  → UPDATE active_shifts SET closed_at WHERE vehicle_id=KV01');
  console.log('  → NEM ír trip_end eseményt');
  console.log('Cleanup: adminFullCleanupVehicle → release + collectAllOpenTrips(lastEvents) close-trip chain');
  console.log('  → getOpenTripsForVehicle uses SAME collectAllOpenTrips(lastEvents) – 1500 ablak');
  console.log('  → KV01 trip NINCS az open listában → cleanup NEM zárja a tripet');
  console.log('Public after release only: activeTripIdsFromEvents(full DB) → trip még nyitott → KV01 public marad');
  console.log('Eredmény Q5: FAIL – nyitott trip maradhat');

  console.log('\n## 9. Járművek: public + operatív + close disabled\n');
  const openFull = collectAllOpenTripsAdmin(allChrono);
  for (const v of pub.vehicles || []) {
    const vid = String(v.vehicle).toUpperCase();
    const openAdmin = openFromAdmin1500.find((t) => String(t.vehicle_id || '').toUpperCase() === vid);
    console.log(`  ${vid}: public=IGEN operatív=IGEN close-trip=${openAdmin ? 'ENABLED' : 'DISABLED'} trip=${v.trip}`);
  }

  console.log('\n## 10. HIBÁS ADATÚTVONAL (1 konkrét sor)\n');
  console.log('Hiba: buildVehiclePositionsFromEvents() server.js ~2382');
  console.log('  const allEvents = selectEventsChronological.all()  ← TELJES DB');
  console.log('  const activeTrips = activeTripIdsFromEvents(allEvents)  ← KV01 trip NYITOTT');
  console.log('vs');
  console.log('  frontend EVENT_FETCH_LIMIT=1500 → collectAllOpenTrips(lastEvents)  ← trip_start KIESIK');
  console.log('\nKonkrét kieső rekord:');
  console.log(JSON.stringify({ id: tripStartRow?.id, type: tripStartRow?.type, trip: tripStartRow?.trip, timestamp: tripStartRow?.timestamp, vehicle_id: tripStartRow?.payload?.vehicle_id }, null, 2));
  console.log('\nRecent ablak határa (1500. legrégebbi):', oldestRecent?.timestamp, oldestRecent?.type, oldestRecent?.trip);

  console.log('\n## 11. Deploy Q7\n');
  console.log('FAIL – KV01 public látható, admin close-trip/cleanup nem tudja lezárni, release után is marad nyitott trip a public-on');

  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
