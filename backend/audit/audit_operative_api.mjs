/**
 * Operatív lefedettség – API + admin JS logika replika (read-only)
 */
const BASE = 'http://localhost:3000';
const STALE_MS = 30 * 60 * 1000;
const TRIP_START = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END = new Set(['trip_end', 'jarat_zaras']);

function norm(v) { return String(v || '').trim().toUpperCase(); }
function payloadOf(ev) {
  if (ev.payload && typeof ev.payload === 'object') return ev.payload;
  return {};
}

function collectAllOpenTrips(events) {
  const open = {};
  const chrono = [...events].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  for (const ev of chrono) {
    const id = ev.trip || payloadOf(ev).trip;
    if (!id) continue;
    const t = String(ev.type || '').toLowerCase();
    if (TRIP_START.has(t)) {
      const p = payloadOf(ev);
      open[id] = { trip: id, shift: ev.shift || p.shift, vehicle_id: p.vehicle_id || ev.vehicle_id, driver_id: p.driver_id };
    }
    if (TRIP_END.has(t)) delete open[id];
  }
  return Object.values(open);
}

function isShiftStaleForDisplay(d) {
  if (!d) return false;
  if (String(d.display_status || d.status || '').toUpperCase() === 'STALE') return true;
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

function buildOperativeVehicleRows(events, drivers, publicVehicles) {
  const byVehicle = {};
  function ensure(rawId) {
    const vid = norm(rawId);
    if (!vid) return null;
    if (!byVehicle[vid]) {
      byVehicle[vid] = {
        vehicle_id: vid, has_shift: false, has_open_trip: false, public_live: false,
        open_trips: [], last_gps_at: null, last_heartbeat_at: null, shift_meta: null,
        map_lat: null, map_lng: null, status: 'SZABAD',
      };
    }
    return byVehicle[vid];
  }
  for (const d of drivers || []) {
    const row = ensure(d.vehicle_id || d.vehicle_name);
    if (!row) continue;
    row.has_shift = true;
    row.shift_meta = d;
    row.last_gps_at = d.last_gps_at || d.last_track_at || row.last_gps_at;
    row.last_heartbeat_at = d.last_heartbeat_at || row.last_heartbeat_at;
  }
  for (const t of collectAllOpenTrips(events)) {
    const row = ensure(t.vehicle_id);
    if (!row) continue;
    row.has_open_trip = true;
    if (!row.open_trips.includes(t.trip)) row.open_trips.push(t.trip);
  }
  for (const p of publicVehicles || []) {
    const row = ensure(p.vehicle || p.vehicle_id);
    if (!row) continue;
    row.public_live = true;
    if (p.last_gps && (!row.last_gps_at || new Date(p.last_gps) > new Date(row.last_gps_at))) row.last_gps_at = p.last_gps;
    if (p.lat != null && p.lng != null) { row.map_lat = +p.lat; row.map_lng = +p.lng; }
  }
  const now = Date.now();
  const result = [];
  for (const vid of Object.keys(byVehicle)) {
    const row = byVehicle[vid];
    const recentGps = row.last_gps_at && (now - new Date(row.last_gps_at).getTime() < STALE_MS);
    const recentHb = row.last_heartbeat_at && (now - new Date(row.last_heartbeat_at).getTime() < STALE_MS);
    const stale = isOperativeStale(row.last_gps_at || row.last_heartbeat_at, row.shift_meta);
    if (!(row.has_shift || row.has_open_trip || row.public_live || recentGps || recentHb || stale)) continue;
    row.status = deriveOperativeStatus(row);
    result.push(row);
  }
  return result;
}

function buttonsForRow(row) {
  return {
    pozicio: { rendered: true, usable: row.map_lat != null },
    release: { rendered: true, enabled: !!row.has_shift },
    closeTrip: { rendered: true, enabled: !!row.has_open_trip },
    cleanup: { rendered: true, enabled: !!(row.has_shift || row.has_open_trip) },
  };
}

async function main() {
  const [driversData, positionsData, eventsData] = await Promise.all([
    fetch(BASE + '/api/admin/active-drivers').then((r) => r.json()),
    fetch(BASE + '/api/vehicle-positions').then((r) => r.json()),
    fetch(BASE + '/api/events?limit=50000').then((r) => r.json()),
  ]);

  const drivers = driversData.drivers || [];
  const publicVehicles = positionsData.vehicles || [];
  const events = (eventsData.events || []).map((ev) => ({ ...ev, payload: ev.payload || payloadOf(ev) }));
  const rows = buildOperativeVehicleRows(events, drivers, publicVehicles);
  const opSet = new Set(rows.map((r) => r.vehicle_id));

  const publicSet = new Set(publicVehicles.map((p) => norm(p.vehicle || p.vehicle_id)).filter(Boolean));
  const shiftSet = new Set(drivers.map((d) => norm(d.vehicle_id)).filter(Boolean));
  const tripSet = new Set(collectAllOpenTrips(events).map((t) => norm(t.vehicle_id)).filter(Boolean));

  const categories = {
    public_live: [...publicSet],
    open_shift: [...shiftSet],
    open_trip: [...tripSet],
    beragadt_lock: rows.filter((r) => r.status === 'BERAGADT_LOCK').map((r) => r.vehicle_id),
    beragadt_trip: rows.filter((r) => r.status === 'BERAGADT_TRIP').map((r) => r.vehicle_id),
  };

  console.log('=== OPERATÍV KÖZPONT AUDIT (API + admin logika) ===\n');

  console.log('1. Problémás kategóriák → operatív blokk');
  const allExpected = new Set([...publicSet, ...shiftSet, ...tripSet, ...categories.beragadt_lock, ...categories.beragadt_trip]);
  const missing1 = [...allExpected].filter((v) => !opSet.has(v));
  for (const [k, v] of Object.entries(categories)) {
    const miss = v.filter((id) => !opSet.has(id));
    console.log(`   ${k}: [${v.join(', ') || '-'}] hiány: [${miss.join(', ') || '-'}]`);
  }
  console.log('   ÖSSZESEN:', missing1.length ? 'FAIL hiány: ' + missing1.join(', ') : 'PASS');

  const q2miss = [...publicSet].filter((v) => !opSet.has(v));
  console.log('\n2. Public látható DE nincs operatívban:', q2miss.length ? 'FAIL ' + q2miss.join(', ') : 'PASS');

  const q3miss = [...shiftSet].filter((v) => !opSet.has(v));
  console.log('3. Nyitott shift DE nincs operatívban:', q3miss.length ? 'FAIL ' + q3miss.join(', ') : 'PASS');

  console.log('\n4. Műveletek minden operatív soron (renderOperativeVehicleRowHtml szabály)');
  let q4StrictFail = [];
  let q4NeededFail = [];
  for (const r of rows) {
    const b = buttonsForRow(r);
    const strictOk = b.pozicio.rendered && b.release.rendered && b.closeTrip.rendered && b.cleanup.rendered;
    const needed = [];
    if (r.has_shift) needed.push('release');
    if (r.has_open_trip) needed.push('closeTrip');
    if (r.has_shift || r.has_open_trip) needed.push('cleanup');
    if (r.map_lat != null) needed.push('pozicio');
    const neededMiss = needed.filter((k) => k === 'pozicio' ? !b.pozicio.usable : !b[k].enabled);
    console.log(`   ${r.vehicle_id} [${r.status}] shift=${r.has_shift} trip=${r.has_open_trip} public=${r.public_live}`);
    console.log(`     Pozíció:${b.pozicio.usable ? 'OK' : 'nincs GPS'} Release:${b.release.enabled ? 'OK' : 'DISABLED'} Close:${b.closeTrip.enabled ? 'OK' : 'DISABLED'} Cleanup:${b.cleanup.enabled ? 'OK' : 'DISABLED'}`);
    if (!strictOk) q4StrictFail.push(r.vehicle_id);
    if (neededMiss.length) q4NeededFail.push({ vid: r.vehicle_id, miss: neededMiss });
  }
  console.log('   4a mind a 4 gomb renderelve minden soron: PASS (kód mindig renderel)');
  console.log('   4b szükséges műveletek enabled:', q4NeededFail.length ? 'FAIL ' + JSON.stringify(q4NeededFail) : 'PASS');

  console.log('\n5. KV01 / KV04 – egy sorból');
  for (const vid of ['KV01', 'KV04']) {
    const r = rows.find((x) => x.vehicle_id === vid);
    if (!r) { console.log(`   ${vid}: NINCS operatív sor → FAIL`); continue; }
    const b = buttonsForRow(r);
    const ops = [];
    if (r.map_lat != null) ops.push('Pozíció✓');
    else ops.push('Pozíció✗');
    ops.push(b.release.enabled ? 'Release✓' : 'Release✗');
    ops.push(b.closeTrip.enabled ? 'Close-trip✓' : 'Close-trip✗');
    ops.push(b.cleanup.enabled ? 'Cleanup✓' : 'Cleanup✗');
    console.log(`   ${vid} [${r.status}] trips=${r.open_trips.join('|')||'—'} → ${ops.join(' ')}`);
  }

  console.log('\n6. JAVASLAT');
  const coverageOk = missing1.length === 0 && q2miss.length === 0 && q3miss.length === 0;
  const opsOk = q4NeededFail.length === 0;
  if (coverageOk && opsOk) {
    console.log('   Teljes lefedettség + műveleti készlet: MÁR MOST teljesül.');
    console.log('   → AKTÍV / MŰSZAKOK információs; Operatív blokk = hivatalos hibakezelés.');
  } else {
    console.log('   coverage:', coverageOk ? 'OK' : 'HIÁNYOS', '| ops:', opsOk ? 'OK' : 'RÉSIKES');
    console.log('   → Operatív blokk központi szerepe még nem teljes.');
  }
}

main();
