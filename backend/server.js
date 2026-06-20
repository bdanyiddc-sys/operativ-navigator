'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(__dirname, 'data', 'events.db');
const routesDir = path.resolve(__dirname, 'routes');
const vehiclesPath = path.join(__dirname, 'data', 'vehicles.json');
const driversPath = path.join(__dirname, 'data', 'drivers.json');
const configPath = path.join(__dirname, 'data', 'config.json');
const schedulesPath = path.join(__dirname, 'data', 'schedules.json');
const routeUploadsDir = path.join(__dirname, 'data', 'route_uploads');
const STALE_SHIFT_MS = 30 * 60 * 1000;
const ROUTE_DISPLAY_TO_SCHEDULE = {
  'Tata-1': 'Tata1',
  'Tata-2': 'Tata2',
  'Tata-3': 'Tata3',
  Teszt01: 'Teszt01',
  Eger: 'Eger',
  Győr: 'Gyor',
  Gyor: 'Gyor',
  Pápa: 'Papa',
  Papa: 'Papa',
  Székesfehérvár: 'Szfv',
  Szfv: 'Szfv',
  Vác: 'Vac',
  Vac: 'Vac',
  Egyedi: '__eseti__',
};
const KNOWN_ROUTE_DISPLAYS = [
  'Tata-1', 'Tata-2', 'Tata-3', 'Teszt01', 'Eger', 'Győr', 'Pápa', 'Székesfehérvár', 'Vác',
];
const ROUTES_SAMPLE_GEOJSON = 'Tata_utvonal2.geojson';
const MASTER_DEFAULT_CAPACITY = 56;
const DEFAULT_VEHICLES = [
  { id: 'KV01', name: 'Kisvonat 1', capacity: 56, local: 'Tata' },
  { id: 'KV02', name: 'Kisvonat 2', capacity: 56, local: 'Tata' },
  { id: 'KV03', name: 'Kisvonat 3', capacity: 56, local: 'Tata' },
  { id: 'KV04', name: 'Kisvonat 4', capacity: 56, local: 'Székesfehérvár' },
  { id: 'KV05', name: 'Kisvonat 5', capacity: 56, local: 'Eger' },
  { id: 'KV06', name: 'Kisvonat 6', capacity: 56, local: 'Győr' },
];
const DEFAULT_DRIVERS = [
  { id: 'DRV01', name: 'Teszt Elek', pin: '1234' },
  { id: 'DRV02', name: 'Minta Béla', pin: '1234' },
  { id: 'DRV03', name: 'Próba János', pin: '1234' },
];

function normalizeMasterVehicle(v) {
  const vehicleId = String(v.vehicle_id || v.id || '').trim();
  if (!vehicleId) return null;
  const vehicleName = String(v.vehicle_name || v.name || '').trim();
  const local = v.local != null ? String(v.local).trim() : '';
  return {
    vehicle_id: vehicleId,
    vehicle_name: vehicleName,
    capacity: Math.max(1, parseInt(v.capacity, 10) || MASTER_DEFAULT_CAPACITY),
    local,
  };
}

function normalizeMasterDriver(d) {
  const driverId = String(d.driver_id || d.id || '').trim();
  if (!driverId) return null;
  const driverName = String(d.driver_name || d.name || '').trim();
  return {
    driver_id: driverId,
    driver_name: driverName,
  };
}

function mapConfigVehicleRow(v) {
  const local = v.local != null
    ? String(v.local).trim()
    : (v.city != null ? String(v.city).trim() : '');
  return normalizeMasterVehicle({
    ...v,
    vehicle_id: v.id || v.vehicle_id,
    vehicle_name: v.name || v.vehicle_name,
    local,
  });
}

function readLegacyVehiclesArray() {
  if (!fs.existsSync(vehiclesPath)) {
    ensureDataDir(vehiclesPath);
    fs.writeFileSync(vehiclesPath, JSON.stringify(DEFAULT_VEHICLES, null, 2), 'utf8');
    return DEFAULT_VEHICLES.slice();
  }
  const raw = JSON.parse(fs.readFileSync(vehiclesPath, 'utf8'));
  if (!Array.isArray(raw)) {
    return DEFAULT_VEHICLES.slice();
  }
  return raw;
}

function readLegacyDriversArray() {
  if (!fs.existsSync(driversPath)) {
    ensureDataDir(driversPath);
    fs.writeFileSync(driversPath, JSON.stringify(DEFAULT_DRIVERS, null, 2), 'utf8');
    return DEFAULT_DRIVERS.slice();
  }
  const raw = JSON.parse(fs.readFileSync(driversPath, 'utf8'));
  if (!Array.isArray(raw)) {
    return DEFAULT_DRIVERS.slice();
  }
  return raw;
}

function getVehicleSourceRows() {
  const raw = readConfigRaw();
  if (raw != null && Array.isArray(raw.vehicles)) {
    return raw.vehicles;
  }
  return readLegacyVehiclesArray();
}

function getDriverSourceRows() {
  const raw = readConfigRaw();
  if (raw != null && Array.isArray(raw.drivers)) {
    return raw.drivers;
  }
  return readLegacyDriversArray();
}

function readVehicles() {
  try {
    return getVehicleSourceRows().map(mapConfigVehicleRow).filter(Boolean);
  } catch (err) {
    console.error('[vehicles] read failed:', err);
    return DEFAULT_VEHICLES.map(normalizeMasterVehicle).filter(Boolean);
  }
}

function readDrivers() {
  try {
    return getDriverSourceRows().map(normalizeMasterDriver).filter(Boolean);
  } catch (err) {
    console.error('[drivers] read failed:', err);
    return DEFAULT_DRIVERS.map(normalizeMasterDriver).filter(Boolean);
  }
}

function writeVehicles(list) {
  const normalized = (Array.isArray(list) ? list : [])
    .map(normalizeMasterVehicle)
    .filter(Boolean);
  const configRows = normalized.map((v) => {
    const row = {
      id: v.vehicle_id,
      city: v.local || '',
    };
    if (v.vehicle_name) row.name = v.vehicle_name;
    if (v.capacity != null) row.capacity = v.capacity;
    return row;
  });
  const raw = readConfigRaw();
  if (raw != null) {
    raw.vehicles = configRows;
    ensureDataDir(configPath);
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
    return normalized;
  }
  ensureDataDir(vehiclesPath);
  const fileRows = normalized.map((v) => ({
    id: v.vehicle_id,
    name: v.vehicle_name || undefined,
    capacity: v.capacity,
    local: v.local || undefined,
  }));
  fs.writeFileSync(vehiclesPath, JSON.stringify(fileRows, null, 2), 'utf8');
  return normalized;
}

function readConfigRaw() {
  try {
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('[config] read failed:', err);
    return null;
  }
}

function mergeConfigRoutes(configRoutes) {
  const seen = new Set();
  const out = [];
  const add = (r) => {
    const s = String(r || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  (Array.isArray(configRoutes) ? configRoutes : []).forEach(add);
  KNOWN_ROUTE_DISPLAYS.forEach(add);
  add('Egyedi');
  return out;
}

function buildConfigResponse() {
  const raw = readConfigRaw();
  const vehicleRows = getVehicleSourceRows();
  const driverRows = getDriverSourceRows();
  const vehicles = vehicleRows.map((v) => {
    const id = String(v.id || v.vehicle_id || '').trim();
    const city = v.city != null
      ? String(v.city).trim()
      : (v.local != null ? String(v.local).trim() : '');
    return { id, city, vehicle_id: id, local: city };
  }).filter((v) => v.id);
  const drivers = driverRows.map((d) => {
    const id = String(d.id || d.driver_id || '').trim();
    const name = String(d.name || d.driver_name || '').trim();
    const pin = d.pin != null ? String(d.pin).trim() : '';
    return { id, name, pin, driver_id: id, driver_name: name };
  }).filter((d) => d.id);
  const routes = mergeConfigRoutes(raw && raw.routes);
  return {
    vehicles,
    drivers,
    routes,
    route_map: ROUTE_DISPLAY_TO_SCHEDULE,
  };
}

function findConfigDriver(driverId) {
  const cfg = buildConfigResponse();
  return cfg.drivers.find((d) => d.id === driverId || d.driver_id === driverId) || null;
}

function validateConfigPin(driverId, pin) {
  const d = findConfigDriver(driverId);
  if (!d) return false;
  return String(d.pin || '') === String(pin || '').trim();
}

function findOpenShiftByVehicle(vehicleId) {
  return db.prepare(`
    SELECT * FROM active_shifts
    WHERE vehicle_id = ? AND closed_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `).get(vehicleId);
}

function touchActiveShiftActivity(shiftId, kind, ts) {
  if (!shiftId) return;
  const when = ts || new Date().toISOString();
  if (kind === 'gps') {
    db.prepare(`
      UPDATE active_shifts SET last_gps_at = @when
      WHERE shift_id = @shift_id AND closed_at IS NULL
    `).run({ shift_id: shiftId, when });
  } else {
    db.prepare(`
      UPDATE active_shifts SET last_heartbeat_at = @when
      WHERE shift_id = @shift_id AND closed_at IS NULL
    `).run({ shift_id: shiftId, when });
  }
}

function computeShiftDisplayStatus(row) {
  const base = String(row.status || 'ACTIVE').trim();
  if (row.closed_at) return 'CLOSED';
  const last = [row.last_gps_at, row.last_heartbeat_at, row.started_at]
    .filter(Boolean)
    .sort()
    .pop();
  if (!last) return base;
  const age = Date.now() - new Date(last).getTime();
  if (age >= STALE_SHIFT_MS && (base === 'ACTIVE' || base === 'TECHNICAL_ISSUE')) {
    return 'STALE';
  }
  return base;
}

function rowToActiveShiftClient(row) {
  if (!row) return null;
  const displayStatus = computeShiftDisplayStatus(row);
  return {
    shift_id: row.shift_id,
    vehicle_id: row.vehicle_id,
    driver_id: row.driver_id,
    driver_name: row.driver_name,
    route: row.route,
    city: row.city,
    status: row.status,
    display_status: displayStatus,
    started_at: row.started_at,
    last_gps_at: row.last_gps_at,
    last_track_at: row.last_gps_at,
    last_heartbeat_at: row.last_heartbeat_at,
    closed_at: row.closed_at,
  };
}

function getActiveShiftsFromDb() {
  const rows = db.prepare(`
    SELECT * FROM active_shifts
    WHERE closed_at IS NULL
    ORDER BY started_at DESC
  `).all();
  return rows.map(rowToActiveShiftClient).filter(Boolean);
}

function closeActiveShiftRow(shiftId, status) {
  const when = new Date().toISOString();
  db.prepare(`
    UPDATE active_shifts
    SET status = @status, closed_at = @when
    WHERE shift_id = @shift_id AND closed_at IS NULL
  `).run({ shift_id: shiftId, status: status || 'CLOSED', when });
}

function releaseVehicleLock(vehicleId) {
  const when = new Date().toISOString();
  db.prepare(`
    UPDATE active_shifts
    SET status = 'CLOSED', closed_at = @when
    WHERE vehicle_id = @vehicle_id AND closed_at IS NULL
  `).run({ vehicle_id: vehicleId, when });
}

function countGeoJsonPoints(geo) {
  if (!geo || !Array.isArray(geo.features)) return 0;
  let n = 0;
  geo.features.forEach((f) => {
    const g = f && f.geometry;
    if (!g) return;
    if (g.type === 'Point') n += 1;
    else if (g.type === 'LineString' && Array.isArray(g.coordinates)) n += g.coordinates.length;
    else if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
      g.coordinates.forEach((line) => { if (Array.isArray(line)) n += line.length; });
    }
  });
  return n;
}

function saveRouteUpload(body) {
  const geo = body && body.geojson;
  if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
    throw new Error('geojson FeatureCollection required');
  }
  const id = `ru_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = body.timestamp || new Date().toISOString();
  const gpsPointCount = body.gps_point_count != null
    ? Math.max(0, parseInt(body.gps_point_count, 10) || 0)
    : countGeoJsonPoints(geo);
  db.prepare(`
    INSERT INTO route_uploads (
      id, timestamp, vehicle_id, driver_id, driver_name, route, gps_point_count, geojson_json
    ) VALUES (
      @id, @timestamp, @vehicle_id, @driver_id, @driver_name, @route, @gps_point_count, @geojson_json
    )
  `).run({
    id,
    timestamp: ts,
    vehicle_id: body.vehicle_id ? String(body.vehicle_id).trim() : null,
    driver_id: body.driver_id ? String(body.driver_id).trim() : null,
    driver_name: body.driver_name ? String(body.driver_name).trim() : null,
    route: body.route ? String(body.route).trim() : null,
    gps_point_count: gpsPointCount,
    geojson_json: JSON.stringify(geo),
  });
  ensureDataDir(routeUploadsDir);
  const fname = `${id}.geojson`;
  fs.writeFileSync(path.join(routeUploadsDir, fname), JSON.stringify(geo, null, 2), 'utf8');
  return { id, timestamp: ts, gps_point_count: gpsPointCount };
}

function logRoutesStartup() {
  const samplePath = path.join(routesDir, ROUTES_SAMPLE_GEOJSON);
  const dirOk = fs.existsSync(routesDir);
  const fileOk = fs.existsSync(samplePath);
  console.log('[ROUTES] routesDir:', routesDir);
  console.log('[ROUTES] fs.existsSync(routesDir):', dirOk);
  console.log('[ROUTES] fs.existsSync(Tata_utvonal2.geojson):', fileOk);
  if (dirOk && fileOk) {
    console.log('[ROUTES] OK');
    console.log('[ROUTES] Tata_utvonal2.geojson found');
  } else {
    console.warn('[ROUTES] NOT READY — missing directory or sample GeoJSON');
  }
}

const TRIP_START_TYPES = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END_TYPES = new Set(['trip_end', 'jarat_zaras']);

function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function initDb(dbPath) {
  ensureDataDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      trip TEXT,
      shift TEXT,
      timestamp TEXT NOT NULL,
      lat REAL,
      lng REAL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_trip ON events(trip);
    CREATE INDEX IF NOT EXISTS idx_events_shift ON events(shift);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      trip_id TEXT,
      type TEXT NOT NULL DEFAULT 'task',
      title TEXT NOT NULL,
      description TEXT,
      lat REAL,
      lng REAL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);
  let taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('vehicle_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN vehicle_id TEXT');
    taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  }
  ['accepted_at', 'picked_up_at', 'done_at', 'cancelled_at'].forEach((col) => {
    if (!taskCols.includes(col)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
      taskCols.push(col);
    }
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_reservations (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      stop_name TEXT NOT NULL,
      stop_id TEXT,
      city TEXT,
      passenger_count INTEGER NOT NULL DEFAULT 1,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      reservation_type TEXT NOT NULL DEFAULT 'scheduled',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sched_res_created ON scheduled_reservations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sched_res_status ON scheduled_reservations(status);
    CREATE TABLE IF NOT EXISTS boarding_requests (
      id TEXT PRIMARY KEY,
      stop_name TEXT NOT NULL,
      stop_id TEXT,
      city TEXT,
      passenger_count INTEGER NOT NULL DEFAULT 1,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_boarding_created ON boarding_requests(created_at DESC);
    CREATE TABLE IF NOT EXISTS custom_orders (
      id TEXT PRIMARY KEY,
      event_date TEXT NOT NULL,
      event_time TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      passenger_count INTEGER NOT NULL DEFAULT 1,
      departure_place TEXT NOT NULL,
      arrival_place TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_created ON custom_orders(created_at DESC);
  `);
  let boardCols = db.prepare('PRAGMA table_info(boarding_requests)').all().map((c) => c.name);
  if (!boardCols.includes('driver_response')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN driver_response TEXT');
    boardCols.push('driver_response');
  }
  if (!boardCols.includes('driver_response_at')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN driver_response_at TEXT');
  }
  if (!boardCols.includes('lat')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN lat REAL');
  }
  if (!boardCols.includes('lng')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN lng REAL');
  }
  let schedCols = db.prepare('PRAGMA table_info(scheduled_reservations)').all().map((c) => c.name);
  if (!schedCols.includes('driver_seen_at')) {
    db.exec('ALTER TABLE scheduled_reservations ADD COLUMN driver_seen_at TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_records (
      id TEXT PRIMARY KEY,
      event_date TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      recorded_by TEXT,
      source TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_service_date ON service_records(event_date DESC);
    CREATE TABLE IF NOT EXISTS driver_notes (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      category TEXT NOT NULL,
      note TEXT NOT NULL,
      driver_id TEXT,
      driver_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_driver_notes_created ON driver_notes(created_at DESC);
    CREATE TABLE IF NOT EXISTS driver_kicks (
      shift_id TEXT PRIMARY KEY,
      kicked_at TEXT NOT NULL DEFAULT (datetime('now')),
      kicked_by TEXT
    );
    CREATE TABLE IF NOT EXISTS active_shifts (
      shift_id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      driver_name TEXT,
      route TEXT,
      city TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      started_at TEXT NOT NULL,
      last_gps_at TEXT,
      last_heartbeat_at TEXT,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_active_shifts_vehicle ON active_shifts(vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_active_shifts_open ON active_shifts(closed_at);
    CREATE TABLE IF NOT EXISTS route_uploads (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      vehicle_id TEXT,
      driver_id TEXT,
      driver_name TEXT,
      route TEXT,
      gps_point_count INTEGER NOT NULL DEFAULT 0,
      geojson_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_route_uploads_ts ON route_uploads(timestamp DESC);
    CREATE TABLE IF NOT EXISTS rent_inquiries (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      event_date TEXT,
      time_start TEXT,
      time_end TEXT,
      customer_name TEXT,
      company_name TEXT,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      city TEXT,
      street TEXT,
      house_number TEXT,
      location_note TEXT,
      lat REAL,
      lng REAL,
      headcount INTEGER,
      vehicle_id TEXT,
      driver_id TEXT,
      business_type TEXT NOT NULL,
      gis_mode TEXT,
      source TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rent_inquiries_event_date ON rent_inquiries(event_date);
    CREATE INDEX IF NOT EXISTS idx_rent_inquiries_status ON rent_inquiries(status);
    CREATE INDEX IF NOT EXISTS idx_rent_inquiries_created_at ON rent_inquiries(created_at);
    CREATE INDEX IF NOT EXISTS idx_rent_inquiries_city ON rent_inquiries(city);
    CREATE INDEX IF NOT EXISTS idx_rent_inquiries_vehicle_id ON rent_inquiries(vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_rent_inquiries_driver_id ON rent_inquiries(driver_id);
    CREATE TABLE IF NOT EXISTS rent_id_sequence (
      year INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0
    );
  `);
  syncRentIdSequenceFromDb(db);
  return db;
}

const REPORT_DEFAULT_CAPACITY = 56;
const REPORT_TICKET_PRICE_HUF = 2800;
const SHIFT_REPORT_TICKET_HUF = REPORT_TICKET_PRICE_HUF;
const tripArchivesDir = path.join(__dirname, 'data', 'trip_archives');
const dailyReportsDir = path.join(__dirname, 'data', 'daily_reports');

function safeArchiveFilename(raw) {
  const base = path.basename(String(raw || '').trim());
  if (!base || !/^[A-Za-z0-9_.-]+\.geojson$/i.test(base)) return null;
  return base;
}

function parseEventPayload(row) {
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return {};
  }
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLng = (lng2 - lng1) * p;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tripDistanceMetersFromRows(tripId, rows) {
  const pts = rows
    .filter((row) => row.trip === tripId && (row.type === 'track' || row.type === 'auto_track'))
    .filter((row) => row.lat != null && row.lng != null)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  let sum = 0;
  for (let i = 1; i < pts.length; i += 1) {
    sum += haversineMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  }
  return Math.round(sum);
}

function countTripEventsByType(tripId, rows, types) {
  const set = new Set(types);
  return rows.filter((row) => row.trip === tripId && set.has(row.type)).length;
}

function buildShiftDailyCsv(shiftId, dateStr) {
  const rows = selectEventsChronological.all();
  const tripsInShift = new Set();
  rows.forEach((row) => {
    if (!TRIP_START_TYPES.has(row.type) || !row.trip) return;
    const p = parseEventPayload(row);
    const sh = String(p.shift || row.shift || '').trim();
    if (shiftId && sh === shiftId) tripsInShift.add(row.trip);
  });
  const summaries = [];
  rows.forEach((row) => {
    if (row.type !== 'trip_summary') return;
    const p = parseEventPayload(row);
    const shift = String(p.shift || row.shift || '').trim();
    const tripId = row.trip || p.trip || '';
    if (shiftId && shift && shift !== shiftId && !tripsInShift.has(tripId)) return;
    if (shiftId && !shift && !tripsInShift.has(tripId)) return;
    const day = localDateKey(p.end_time || p.start_time || row.timestamp);
    if (dateStr && day !== dateStr) return;
    summaries.push({
      trip: row.trip || p.trip || '',
      start_time: p.start_time || null,
      end_time: p.end_time || row.timestamp,
      duration_min: p.duration_min != null ? p.duration_min : null,
      passenger_total: p.passenger_total != null ? p.passenger_total : 0,
      vehicle_id: p.vehicle_id || '',
      shift,
    });
  });

  const header = [
    'Járat', 'Indulás', 'Érkezés', 'Menetidő', 'Megtett távolság',
    'Utasok száma', 'Foglalások száma', 'Felszállási igények száma',
    'Jegybevétel (Ft)', 'Egyéb bevétel (Ft)', 'Összes bevétel (Ft)',
  ];
  const lines = [header.join(';')];
  let totalRevenue = 0;

  summaries.forEach((s) => {
    const tripId = s.trip;
    const distM = tripDistanceMetersFromRows(tripId, rows);
    const reservations = countTripEventsByType(tripId, rows, ['reservation', 'foglalas', 'booking']);
    const boardings = countTripEventsByType(tripId, rows, ['boarding', 'felszallas']);
    const pax = Math.max(0, parseInt(s.passenger_total, 10) || 0);
    const ticketRev = pax * SHIFT_REPORT_TICKET_HUF;
    const otherRev = 0;
    const totalRev = ticketRev + otherRev;
    totalRevenue += totalRev;
    lines.push([
      tripId,
      s.start_time || '',
      s.end_time || '',
      s.duration_min != null ? s.duration_min : '',
      distM,
      pax,
      reservations,
      boardings,
      ticketRev,
      otherRev,
      totalRev,
    ].join(';'));
  });

  lines.push(['ÖSSZESEN', '', '', '', '', '', '', '', '', '', String(totalRevenue)].join(';'));
  return '\uFEFF' + lines.join('\r\n');
}

function listTripArchiveFiles() {
  ensureDataDir(tripArchivesDir);
  if (!fs.existsSync(tripArchivesDir)) return [];
  return fs.readdirSync(tripArchivesDir)
    .filter((f) => f.toLowerCase().endsWith('.geojson'))
    .map((filename) => {
      const full = path.join(tripArchivesDir, filename);
      let meta = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        meta = (parsed && parsed.properties) ? parsed.properties : {};
      } catch {
        meta = {};
      }
      const stat = fs.statSync(full);
      const m = filename.match(/^([A-Za-z0-9]+)_(\d{8})_(\d{4})/);
      return {
        filename,
        trip_id: meta.trip || meta.trip_id || null,
        vehicle_id: meta.vehicle_id || (m ? m[1] : null),
        start_time: meta.start_time || null,
        end_time: meta.end_time || null,
        size_bytes: stat.size,
        saved_at: stat.mtime.toISOString(),
        label: m ? `${m[1]} - ${m[3].slice(0, 2)}:${m[3].slice(2)}` : filename,
      };
    })
    .sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
}

function saveTripArchive(body) {
  const geo = body && body.geojson;
  if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
    throw new Error('geojson FeatureCollection required');
  }
  const props = geo.properties || {};
  let filename = safeArchiveFilename(body.filename);
  if (!filename) {
    const vid = String(body.vehicle_id || props.vehicle_id || 'TRIP').replace(/[^\w-]+/g, '');
    const d = new Date(body.start_time || props.start_time || Date.now());
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const hm = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    filename = `${vid}_${ymd}_${hm}_trip.geojson`;
  }
  ensureDataDir(tripArchivesDir);
  const enriched = {
    ...geo,
    properties: {
      ...props,
      trip: body.trip_id || props.trip || null,
      trip_id: body.trip_id || props.trip || null,
      vehicle_id: body.vehicle_id || props.vehicle_id || null,
      start_time: body.start_time || props.start_time || null,
      end_time: body.end_time || props.end_time || null,
      archived_at: new Date().toISOString(),
    },
  };
  const full = path.join(tripArchivesDir, filename);
  fs.writeFileSync(full, JSON.stringify(enriched, null, 2), 'utf8');
  return { filename, path: full };
}

function saveDailyShiftCsv(shiftId, dateStr) {
  const csv = buildShiftDailyCsv(shiftId, dateStr);
  ensureDataDir(dailyReportsDir);
  const fname = `napi_jaratok_${dateStr || parseReportDate(null)}_${String(shiftId || 'shift').replace(/[^\w-]+/g, '_').slice(0, 40)}.csv`;
  const full = path.join(dailyReportsDir, fname);
  fs.writeFileSync(full, csv, 'utf8');
  return { filename: fname, path: full };
}
const SERVICE_TYPES = new Set(['olajcsere', 'fek', 'gumi', 'akkumulátor', 'lampa', 'tisztitas', 'egyeb']);
const SERVICE_STATUSES = new Set(['open', 'in_progress', 'done', 'cancelled']);
const DRIVER_NOTE_CATEGORIES = new Set(['hiba', 'karbantartas', 'tisztitas', 'utaspanasz', 'egyeb']);

const TASK_STATUSES = new Set(['pending', 'accepted', 'picked_up', 'done', 'cancelled']);

const TASK_STATUS_TS_COLUMN = {
  accepted: 'accepted_at',
  picked_up: 'picked_up_at',
  done: 'done_at',
  cancelled: 'cancelled_at',
};

function taskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseTaskStatusQuery(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => TASK_STATUSES.has(s));
  return list.length ? list : null;
}

function normalizeIncomingTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = raw.title != null ? String(raw.title).trim() : '';
  if (!title) return null;
  const lat = raw.lat != null ? Number(raw.lat) : null;
  const lng = raw.lng != null ? Number(raw.lng) : null;
  const tripId = raw.trip_id != null && String(raw.trip_id).trim() !== ''
    ? String(raw.trip_id).trim()
    : raw.trip != null && String(raw.trip).trim() !== ''
      ? String(raw.trip).trim()
      : null;
  const type = raw.type != null && String(raw.type).trim() !== ''
    ? String(raw.type).trim()
    : 'task';
  const statusRaw = raw.status != null ? String(raw.status).trim() : 'pending';
  const status = TASK_STATUSES.has(statusRaw) ? statusRaw : 'pending';
  const vehicleId = raw.vehicle_id != null && String(raw.vehicle_id).trim() !== ''
    ? String(raw.vehicle_id).trim()
    : null;
  return {
    id: raw.id != null && String(raw.id).trim() !== '' ? String(raw.id).trim() : taskId(),
    trip_id: tripId,
    vehicle_id: vehicleId,
    type,
    title,
    description: raw.description != null ? String(raw.description) : '',
    lat: lat != null && !Number.isNaN(lat) ? lat : null,
    lng: lng != null && !Number.isNaN(lng) ? lng : null,
    status,
  };
}

function normalizeTaskUpdate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id != null ? String(raw.id).trim() : '';
  if (!id) return null;
  const title = raw.title != null ? String(raw.title).trim() : '';
  if (!title) return null;
  const statusRaw = raw.status != null ? String(raw.status).trim() : 'pending';
  const status = TASK_STATUSES.has(statusRaw) ? statusRaw : 'pending';
  const lat = raw.lat != null ? Number(raw.lat) : null;
  const lng = raw.lng != null ? Number(raw.lng) : null;
  const tripId = raw.trip_id != null && String(raw.trip_id).trim() !== ''
    ? String(raw.trip_id).trim()
    : raw.trip != null && String(raw.trip).trim() !== ''
      ? String(raw.trip).trim()
      : null;
  const vehicleId = raw.vehicle_id != null && String(raw.vehicle_id).trim() !== ''
    ? String(raw.vehicle_id).trim()
    : null;
  return {
    id,
    trip_id: tripId,
    vehicle_id: vehicleId,
    type: raw.type != null && String(raw.type).trim() !== '' ? String(raw.type).trim() : 'task',
    title,
    description: raw.description != null ? String(raw.description) : '',
    lat: lat != null && !Number.isNaN(lat) ? lat : null,
    lng: lng != null && !Number.isNaN(lng) ? lng : null,
    status,
  };
}

function rowToTaskClient(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    accepted_at: row.accepted_at || null,
    picked_up_at: row.picked_up_at || null,
    done_at: row.done_at || null,
    cancelled_at: row.cancelled_at || null,
    trip_id: row.trip_id,
    vehicle_id: row.vehicle_id || null,
    type: row.type,
    title: row.title,
    description: row.description || '',
    lat: row.lat,
    lng: row.lng,
    status: row.status,
  };
}

function eventTimestamp(ev) {
  return (
    ev.timestamp ||
    ev.start_time ||
    ev.time ||
    new Date().toISOString()
  );
}

function eventTrip(ev) {
  const t = ev.trip || ev.jaratszam || ev.jarat_szam;
  return t != null && String(t).trim() !== '' ? String(t).trim() : null;
}

function eventShift(ev) {
  const s = ev.shift;
  return s != null && String(s).trim() !== '' ? String(s).trim() : null;
}

function eventId(ev) {
  if (ev.id != null && String(ev.id).trim() !== '') {
    return String(ev.id).trim();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeIncomingEvent(raw) {
  if (!raw || typeof raw !== 'object' || !raw.type) {
    return null;
  }
  const type = String(raw.type).trim();
  if (!type) return null;

  const id = eventId(raw);
  const trip = eventTrip(raw);
  const shift = eventShift(raw);
  const timestamp = eventTimestamp(raw);
  const lat = raw.lat != null ? Number(raw.lat) : null;
  const lng = raw.lng != null ? Number(raw.lng) : null;

  return {
    id,
    type,
    trip,
    shift,
    timestamp,
    lat: lat != null && !Number.isNaN(lat) ? lat : null,
    lng: lng != null && !Number.isNaN(lng) ? lng : null,
    payload_json: JSON.stringify(raw),
  };
}

function rowToClient(row) {
  let payload = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = row.payload_json;
  }
  return {
    id: row.id,
    type: row.type,
    trip: row.trip,
    shift: row.shift,
    timestamp: row.timestamp,
    lat: row.lat,
    lng: row.lng,
    created_at: row.created_at,
    payload,
  };
}

const db = initDb(DATABASE_PATH);

const RESERVATION_STATUSES = new Set(['new', 'accepted', 'modified', 'cancelled']);
const BOARDING_DRIVER_RESPONSES = new Set(['can_stop', 'full', 'unsafe', 'not_on_route', 'other']);

function normalizeCityKey(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  return String(raw).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Public city ids (tata, szfv, …) → normalized label aliases for filter matching */
const PUBLIC_CITY_ALIASES = {
  tata: ['tata'],
  eger: ['eger'],
  gyor: ['gyor'],
  papa: ['papa'],
  szfv: ['szfv', 'szekesfehervar'],
  vac: ['vac'],
};

const PUBLIC_CITY_CENTERS = {
  tata: { lat: 47.649, lng: 18.318 },
  eger: { lat: 47.902, lng: 20.377 },
  gyor: { lat: 47.687, lng: 17.635 },
  papa: { lat: 47.330, lng: 17.467 },
  szfv: { lat: 47.192, lng: 18.411 },
  vac: { lat: 47.775, lng: 19.134 },
};

function allowedCityKeys(cityRaw) {
  const key = normalizeCityKey(cityRaw);
  if (!key) return null;
  for (const aliases of Object.values(PUBLIC_CITY_ALIASES)) {
    const normalized = aliases.map((a) => normalizeCityKey(a));
    if (normalized.includes(key)) return new Set(normalized);
  }
  return new Set([key]);
}

function publicCityIdFromLabel(raw) {
  const key = normalizeCityKey(raw);
  if (!key) return null;
  for (const [id, aliases] of Object.entries(PUBLIC_CITY_ALIASES)) {
    if (normalizeCityKey(id) === key) return id;
    if (aliases.some((a) => normalizeCityKey(a) === key)) return id;
  }
  return null;
}

function nearestPublicCityId(lat, lng) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  let best = null;
  let bestD = Infinity;
  for (const [id, c] of Object.entries(PUBLIC_CITY_CENTERS)) {
    const d = ((lat - c.lat) ** 2) + ((lng - c.lng) ** 2);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function primaryPublicCityId(row) {
  const local = row.vehicle_local || row.vehicleLocal || null;
  if (local) {
    const fromLocal = publicCityIdFromLabel(local);
    if (fromLocal) return fromLocal;
  }
  if (row.lat != null && row.lng != null) {
    const fromGps = nearestPublicCityId(Number(row.lat), Number(row.lng));
    if (fromGps) return fromGps;
  }
  if (row.city) {
    const fromTrip = publicCityIdFromLabel(row.city);
    if (fromTrip) return fromTrip;
  }
  return null;
}

function normalizeDbTimestamp(ts) {
  if (ts == null || ts === '') return null;
  const s = String(ts).trim();
  if (!s) return null;
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  return s;
}

function normalizeHuPhone(raw) {
  if (raw == null) return '';
  let p = String(raw).trim().replace(/[\s().-]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('06')) p = '+36' + p.slice(2);
  else if (/^36\d{9,}$/.test(p)) p = '+' + p;
  if (!/^\+36\d{9}$/.test(p)) return '';
  return p;
}

function formatHuPhoneDisplay(phone) {
  const normalized = normalizeHuPhone(phone);
  if (normalized) {
    const m = normalized.match(/^\+36(\d{2})(\d{3})(\d{3,4})$/);
    if (m) return `+36 ${m[1]} ${m[2]} ${m[3]}`;
    return normalized;
  }
  const raw = String(phone || '').trim();
  return raw || '';
}

function bookingId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function seedBookingsIfEmpty() {
  const schedCount = db.prepare('SELECT COUNT(*) AS n FROM scheduled_reservations').get().n;
  if (schedCount === 0) {
    const ins = db.prepare(`
      INSERT INTO scheduled_reservations (id, time, stop_name, stop_id, city, passenger_count, phone, status, reservation_type, note)
      VALUES (@id, @time, @stop_name, @stop_id, @city, @passenger_count, @phone, @status, @reservation_type, @note)
    `);
    [
      { id: 'rsv_demo_1', time: '15:08', stop_name: 'Vármegálló', stop_id: 'stop_varmegallo', city: 'Tata', passenger_count: 2, phone: '+36 30 123 4567', status: 'new', reservation_type: 'scheduled', note: '' },
      { id: 'rsv_demo_2', time: '15:15', stop_name: 'Tatai vár', stop_id: 'stop_var', city: 'Tata', passenger_count: 4, phone: '+36 20 555 1212', status: 'accepted', reservation_type: 'scheduled', note: '' },
      { id: 'rsv_demo_3', time: '16:00', stop_name: 'Indulási pont', stop_id: 'stop_tata_ind', city: 'Tata', passenger_count: 3, phone: '+36 70 111 2233', status: 'new', reservation_type: 'scheduled', note: 'Gyerekülés' },
    ].forEach((row) => ins.run(row));
  }
  const boardCount = db.prepare('SELECT COUNT(*) AS n FROM boarding_requests').get().n;
  if (boardCount === 0) {
    const insB = db.prepare(`
      INSERT INTO boarding_requests (id, stop_name, stop_id, city, passenger_count, phone, status, created_at)
      VALUES (@id, @stop_name, @stop_id, @city, @passenger_count, @phone, @status, @created_at)
    `);
    const now = new Date().toISOString();
    insB.run({
      id: 'brd_demo_1',
      stop_name: 'Tatai vár',
      stop_id: 'stop_var',
      city: 'Tata',
      passenger_count: 4,
      phone: '+36 20 987 6543',
      status: 'active',
      created_at: now,
    });
    insB.run({
      id: 'brd_demo_2',
      stop_name: 'Vármegálló',
      stop_id: 'stop_varmegallo',
      city: 'Tata',
      passenger_count: 2,
      phone: '+36 30 444 7788',
      status: 'active',
      created_at: new Date(Date.now() - 3600000).toISOString(),
    });
  }
  const customCount = db.prepare('SELECT COUNT(*) AS n FROM custom_orders').get().n;
  if (customCount === 0) {
    db.prepare(`
      INSERT INTO custom_orders (id, event_date, event_time, customer_name, phone, passenger_count, departure_place, arrival_place, note, status)
      VALUES (@id, @event_date, @event_time, @customer_name, @phone, @passenger_count, @departure_place, @arrival_place, @note, @status)
    `).run({
      id: 'cst_demo_1',
      event_date: '2026.06.12',
      event_time: '17:00',
      customer_name: 'Esküvő',
      phone: '+36 30 999 0000',
      passenger_count: 32,
      departure_place: 'Tatai vár',
      arrival_place: 'Öreg-tó',
      note: 'Koccintós túra',
      status: 'new',
    });
  }
}

seedBookingsIfEmpty();

const selectScheduled = db.prepare(`
  SELECT * FROM scheduled_reservations
  WHERE status != 'cancelled'
  ORDER BY time ASC, created_at DESC
  LIMIT ?
`);
const selectBoarding = db.prepare(`
  SELECT * FROM boarding_requests
  WHERE status IN ('active', 'responded')
  ORDER BY created_at DESC
  LIMIT ?
`);
const selectBoardingActive = db.prepare(`
  SELECT * FROM boarding_requests
  WHERE status = 'active'
  ORDER BY created_at DESC
  LIMIT ?
`);
const selectCustom = db.prepare(`
  SELECT * FROM custom_orders
  WHERE status != 'cancelled'
  ORDER BY event_date ASC, event_time ASC
  LIMIT ?
`);
const insertScheduled = db.prepare(`
  INSERT INTO scheduled_reservations (id, time, stop_name, stop_id, city, passenger_count, phone, status, reservation_type, note)
  VALUES (@id, @time, @stop_name, @stop_id, @city, @passenger_count, @phone, @status, @reservation_type, @note)
`);
const insertBoarding = db.prepare(`
  INSERT INTO boarding_requests (id, stop_name, stop_id, city, passenger_count, phone, status, created_at, lat, lng)
  VALUES (@id, @stop_name, @stop_id, @city, @passenger_count, @phone, 'active', @created_at, @lat, @lng)
`);
const updateScheduledStatus = db.prepare(`
  UPDATE scheduled_reservations SET status = @status, updated_at = datetime('now') WHERE id = @id
`);
const updateScheduledFields = db.prepare(`
  UPDATE scheduled_reservations
  SET time = @time, stop_name = @stop_name, passenger_count = @passenger_count, phone = @phone,
      status = @status, note = @note, updated_at = datetime('now')
  WHERE id = @id
`);
const dismissBoarding = db.prepare(`
  UPDATE boarding_requests SET status = 'dismissed' WHERE id = @id
`);
const respondBoarding = db.prepare(`
  UPDATE boarding_requests
  SET driver_response = @driver_response, driver_response_at = datetime('now'), status = 'responded'
  WHERE id = @id AND status = 'active'
`);
const markScheduledSeen = db.prepare(`
  UPDATE scheduled_reservations SET driver_seen_at = @seen_at WHERE id = @id AND driver_seen_at IS NULL
`);
const getScheduledById = db.prepare('SELECT * FROM scheduled_reservations WHERE id = ?');
const getBoardingById = db.prepare('SELECT * FROM boarding_requests WHERE id = ?');
const selectServiceRecords = db.prepare(`
  SELECT * FROM service_records ORDER BY event_date DESC, created_at DESC LIMIT ?
`);
const insertServiceRecord = db.prepare(`
  INSERT INTO service_records (id, event_date, vehicle_id, service_type, status, note, recorded_by, source)
  VALUES (@id, @event_date, @vehicle_id, @service_type, @status, @note, @recorded_by, @source)
`);
const selectDriverNotes = db.prepare(`
  SELECT * FROM driver_notes ORDER BY created_at DESC LIMIT ?
`);
const selectDriverNoteById = db.prepare(`
  SELECT * FROM driver_notes WHERE id = ?
`);
const insertDriverNote = db.prepare(`
  INSERT INTO driver_notes (id, vehicle_id, category, note, driver_id, driver_name)
  VALUES (@id, @vehicle_id, @category, @note, @driver_id, @driver_name)
`);
const getRentInquiryById = db.prepare('SELECT * FROM rent_inquiries WHERE id = ?');
const insertRentInquiry = db.prepare(`
  INSERT INTO rent_inquiries (
    id, created_at, updated_at, status, event_date, time_start, time_end,
    customer_name, company_name, contact_name, phone, email,
    city, street, house_number, location_note, lat, lng, headcount,
    vehicle_id, driver_id, business_type, gis_mode, source, payload_json
  ) VALUES (
    @id, @created_at, @updated_at, @status, @event_date, @time_start, @time_end,
    @customer_name, @company_name, @contact_name, @phone, @email,
    @city, @street, @house_number, @location_note, @lat, @lng, @headcount,
    @vehicle_id, @driver_id, @business_type, @gis_mode, @source, @payload_json
  )
`);
const updateRentInquiry = db.prepare(`
  UPDATE rent_inquiries SET
    updated_at = @updated_at,
    status = @status,
    event_date = @event_date,
    time_start = @time_start,
    time_end = @time_end,
    customer_name = @customer_name,
    company_name = @company_name,
    contact_name = @contact_name,
    phone = @phone,
    email = @email,
    city = @city,
    street = @street,
    house_number = @house_number,
    location_note = @location_note,
    lat = @lat,
    lng = @lng,
    headcount = @headcount,
    vehicle_id = @vehicle_id,
    driver_id = @driver_id,
    gis_mode = @gis_mode,
    source = @source,
    payload_json = @payload_json
  WHERE id = @id
`);
const deleteRentInquiry = db.prepare('DELETE FROM rent_inquiries WHERE id = ?');
const deleteAllRentInquiries = db.prepare('DELETE FROM rent_inquiries');
const selectAllRentInquiryIds = db.prepare('SELECT id FROM rent_inquiries');

function opsId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseReportDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localDateKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildDailyVehicleReport(dateStr, vehicleIdFilter) {
  const rows = selectEventsChronological.all();
  const byVehicle = {};
  rows.forEach((row) => {
    if (row.type !== 'trip_summary') return;
    const day = localDateKey(row.timestamp);
    if (day !== dateStr) return;
    let p = {};
    try {
      p = JSON.parse(row.payload_json);
    } catch {
      p = {};
    }
    const vid = String(p.vehicle_id || row.trip || '').trim() || 'ismeretlen';
    if (vehicleIdFilter && vid !== vehicleIdFilter) return;
    const pax = Math.max(0, parseInt(p.passenger_total, 10) || 0);
    if (!byVehicle[vid]) {
      byVehicle[vid] = {
        vehicle_id: vid,
        vehicle_name: p.vehicle_name || vid,
        passengers: 0,
        trip_count: 0,
      };
    }
    byVehicle[vid].passengers += pax;
    byVehicle[vid].trip_count += 1;
    if (p.vehicle_name && !byVehicle[vid].vehicle_name) {
      byVehicle[vid].vehicle_name = p.vehicle_name;
    }
  });
  return Object.values(byVehicle).map((v) => {
    const cap = REPORT_DEFAULT_CAPACITY;
    const pax = v.passengers;
    const free = Math.max(0, cap - pax);
    const util = cap > 0 ? Math.round((pax / cap) * 1000) / 10 : 0;
    return {
      date: dateStr,
      vehicle_id: v.vehicle_id,
      vehicle_name: v.vehicle_name,
      trip_count: v.trip_count,
      passengers: pax,
      capacity: cap,
      free_seats: free,
      utilization_pct: util,
      revenue_huf: pax * REPORT_TICKET_PRICE_HUF,
      ticket_price_huf: REPORT_TICKET_PRICE_HUF,
    };
  }).sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id));
}

function rowToServiceRecord(row) {
  return {
    id: row.id,
    event_date: row.event_date,
    vehicle_id: row.vehicle_id,
    service_type: row.service_type,
    status: row.status,
    note: row.note || '',
    recorded_by: row.recorded_by || '',
    source: row.source || 'admin',
    created_at: row.created_at,
  };
}

function rowToDriverNote(row) {
  return {
    id: row.id,
    vehicle_id: row.vehicle_id,
    category: row.category,
    note: row.note,
    driver_id: row.driver_id || '',
    driver_name: row.driver_name || '',
    created_at: normalizeDbTimestamp(row.created_at),
  };
}

function normalizeServiceRecordInput(body) {
  if (!body || typeof body !== 'object') return null;
  const vehicleId = body.vehicle_id != null ? String(body.vehicle_id).trim() : '';
  const serviceType = body.service_type != null ? String(body.service_type).trim() : '';
  const eventDate = body.event_date != null ? String(body.event_date).trim() : parseReportDate(null);
  if (!vehicleId || !serviceType || !SERVICE_TYPES.has(serviceType)) return null;
  const status = body.status != null ? String(body.status).trim() : 'open';
  return {
    id: opsId('svc'),
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : parseReportDate(null),
    vehicle_id: vehicleId,
    service_type: serviceType,
    status: SERVICE_STATUSES.has(status) ? status : 'open',
    note: body.note != null ? String(body.note).trim() : '',
    recorded_by: body.recorded_by != null ? String(body.recorded_by).trim() : '',
    source: 'admin',
  };
}

function normalizeDriverNoteInput(body) {
  if (!body || typeof body !== 'object') return null;
  const vehicleId = body.vehicle_id != null ? String(body.vehicle_id).trim() : '';
  const category = body.category != null ? String(body.category).trim() : '';
  const note = body.note != null ? String(body.note).trim() : '';
  if (!vehicleId || !category || !note || !DRIVER_NOTE_CATEGORIES.has(category)) return null;
  return {
    id: opsId('dn'),
    vehicle_id: vehicleId,
    category,
    note,
    driver_id: body.driver_id != null ? String(body.driver_id).trim() : '',
    driver_name: body.driver_name != null ? String(body.driver_name).trim() : '',
  };
}

function filterRowsByCity(rows, cityRaw) {
  const allowed = allowedCityKeys(cityRaw);
  if (!allowed) return rows;
  return rows.filter((row) => {
    const primary = primaryPublicCityId(row);
    if (!primary) return true;
    const primaryAllowed = allowedCityKeys(primary);
    if (!primaryAllowed) return allowed.has(normalizeCityKey(primary));
    for (const k of primaryAllowed) {
      if (allowed.has(k)) return true;
    }
    return false;
  });
}

function rowToScheduled(row) {
  return {
    id: row.id,
    time: row.time,
    stop_name: row.stop_name,
    stop_id: row.stop_id,
    city: row.city,
    passenger_count: row.passenger_count,
    phone: formatHuPhoneDisplay(row.phone),
    status: row.status,
    reservation_type: row.reservation_type || 'scheduled',
    note: row.note || '',
    created_at: normalizeDbTimestamp(row.created_at),
    updated_at: normalizeDbTimestamp(row.updated_at),
    driver_seen_at: normalizeDbTimestamp(row.driver_seen_at),
  };
}

function rowToBoarding(row) {
  return {
    id: row.id,
    stop_name: row.stop_name,
    stop_id: row.stop_id,
    city: row.city,
    passenger_count: row.passenger_count,
    phone: formatHuPhoneDisplay(row.phone),
    status: row.status,
    lat: row.lat != null ? row.lat : null,
    lng: row.lng != null ? row.lng : null,
    created_at: normalizeDbTimestamp(row.created_at),
    driver_response: row.driver_response || null,
    driver_response_at: normalizeDbTimestamp(row.driver_response_at),
  };
}

function rowToCustom(row) {
  return {
    id: row.id,
    event_date: row.event_date,
    event_time: row.event_time,
    customer_name: row.customer_name,
    phone: formatHuPhoneDisplay(row.phone),
    passenger_count: row.passenger_count,
    departure_place: row.departure_place,
    arrival_place: row.arrival_place,
    note: row.note || '',
    status: row.status,
    created_at: normalizeDbTimestamp(row.created_at),
  };
}

function rentPickStr(body, ...keys) {
  for (const k of keys) {
    if (body[k] != null && String(body[k]).trim() !== '') return String(body[k]).trim();
  }
  return '';
}

function normalizeRentGisMode(body) {
  const raw = body.booking_type != null ? body.booking_type : body.gis_mode;
  const s = String(raw != null ? raw : 'single_location').trim().toLowerCase();
  return s === 'custom_route' ? 'custom_route' : 'single_location';
}

function normalizeRentStatus(raw) {
  if (raw == null || String(raw).trim() === '') return 'ARAJANLATKERES';
  const s = String(raw).trim();
  return s === 'ERDEKLODES' ? 'ARAJANLATKERES' : s;
}

function parseRentInquirySeq(id) {
  const m = String(id || '').match(/^RENT-(\d{4})-(\d+)$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), seq: parseInt(m[2], 10) };
}

function setRentIdSequenceAtLeast(year, seq, dbConn) {
  const conn = dbConn || db;
  const y = parseInt(year, 10);
  const s = parseInt(seq, 10);
  if (!Number.isFinite(y) || !Number.isFinite(s) || s < 0) return;
  const row = conn.prepare('SELECT last_seq FROM rent_id_sequence WHERE year = ?').get(y);
  if (!row) {
    conn.prepare('INSERT INTO rent_id_sequence (year, last_seq) VALUES (?, ?)').run(y, s);
  } else if (s > row.last_seq) {
    conn.prepare('UPDATE rent_id_sequence SET last_seq = ? WHERE year = ?').run(s, y);
  }
}

function syncRentIdSequenceFromDb(dbConn) {
  const conn = dbConn || db;
  const rows = conn.prepare(`
    SELECT id FROM rent_inquiries WHERE id LIKE 'RENT-%'
  `).all();
  const maxByYear = {};
  rows.forEach((row) => {
    const parsed = parseRentInquirySeq(row.id);
    if (!parsed) return;
    maxByYear[parsed.year] = Math.max(maxByYear[parsed.year] || 0, parsed.seq);
  });
  Object.keys(maxByYear).forEach((year) => {
    setRentIdSequenceAtLeast(parseInt(year, 10), maxByYear[year], conn);
  });
  const currentYear = new Date().getFullYear();
  if (!conn.prepare('SELECT 1 AS n FROM rent_id_sequence WHERE year = ?').get(currentYear)) {
    conn.prepare('INSERT INTO rent_id_sequence (year, last_seq) VALUES (?, 0)').run(currentYear);
  }
}

function bumpRentIdSequenceFromIds(ids, dbConn) {
  (ids || []).forEach((id) => {
    const parsed = parseRentInquirySeq(id);
    if (parsed) setRentIdSequenceAtLeast(parsed.year, parsed.seq, dbConn);
  });
}

function generateRentInquiryId() {
  const year = new Date().getFullYear();
  const prefix = `RENT-${year}-`;
  return db.transaction(() => {
    syncRentIdSequenceFromDb(db);
    const row = db.prepare('SELECT last_seq FROM rent_id_sequence WHERE year = ?').get(year);
    let seq = (row && Number.isFinite(row.last_seq) ? row.last_seq : 0) + 1;
    const existsStmt = db.prepare('SELECT 1 AS n FROM rent_inquiries WHERE id = ?');
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidate = seq + attempt;
      const id = `${prefix}${String(candidate).padStart(4, '0')}`;
      if (!existsStmt.get(id)) {
        db.prepare('UPDATE rent_id_sequence SET last_seq = ? WHERE year = ?').run(candidate, year);
        return id;
      }
    }
    const fallbackSeq = parseInt(String(Date.now()).slice(-8), 10);
    setRentIdSequenceAtLeast(year, fallbackSeq);
    return `${prefix}${String(fallbackSeq).padStart(4, '0')}`;
  })();
}

function rentImportCustomer(item) {
  return rentPickStr(item, 'customer_name', 'name', 'ordererName') || '';
}

function rentImportAddress(item) {
  if (item && item.address != null && String(item.address).trim() !== '') {
    return String(item.address).trim();
  }
  return [item && item.street, item && (item.houseNumber || item.house_number)]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function rentStableJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function rentTimestampMs(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function rentInquiryAsImportSource(rowOrItem) {
  if (!rowOrItem) return {};
  if (rowOrItem.payload_json != null || rowOrItem.created_at != null) {
    return rowToRentInquiry(rowOrItem);
  }
  return rowOrItem;
}

function rentImportSnapshot(rowOrItem) {
  const obj = rentInquiryAsImportSource(rowOrItem);
  return {
    updatedAt: obj.updatedAt || obj.updated_at || null,
    customer: rentImportCustomer(obj),
    date: rentPickStr(obj, 'event_date', 'date'),
    city: rentPickStr(obj, 'city'),
    address: rentImportAddress(obj),
    lat: obj.lat != null && obj.lat !== '' && !Number.isNaN(Number(obj.lat)) ? Number(obj.lat) : null,
    lng: obj.lng != null && obj.lng !== '' && !Number.isNaN(Number(obj.lng)) ? Number(obj.lng) : null,
    routePoints: rentStableJson(obj.routePoints),
    routeGeometry: rentStableJson(obj.routeGeometry),
    routeDraft: rentStableJson(obj.routeDraft),
    vehicle: rentPickStr(obj, 'vehicle', 'vehicle_id'),
    driver: rentPickStr(obj, 'driver', 'driver_id'),
    status: normalizeRentStatus(obj.status),
  };
}

function rentImportSnapshotsEqual(a, b) {
  const keys = Object.keys(a);
  return keys.every((key) => a[key] === b[key]);
}

function decideRentImportAction(backupItem, existingRow) {
  if (!existingRow) {
    return { action: 'import', decision: 'insert' };
  }
  const backupSnap = rentImportSnapshot(backupItem);
  const dbSnap = rentImportSnapshot(existingRow);
  const backupUpdatedAt = backupSnap.updatedAt;
  const dbUpdatedAt = dbSnap.updatedAt;
  if (rentImportSnapshotsEqual(backupSnap, dbSnap)) {
    return {
      action: 'skip',
      decision: 'identical',
      backupUpdatedAt,
      dbUpdatedAt,
    };
  }
  const backupMs = rentTimestampMs(backupUpdatedAt);
  const dbMs = rentTimestampMs(dbUpdatedAt);
  if (backupMs != null && dbMs != null) {
    if (backupMs > dbMs) {
      return { action: 'update', decision: 'backup_newer', backupUpdatedAt, dbUpdatedAt };
    }
    if (dbMs > backupMs) {
      return { action: 'skip', decision: 'db_newer', backupUpdatedAt, dbUpdatedAt };
    }
    return { action: 'conflict', decision: 'same_time_diff_content', backupUpdatedAt, dbUpdatedAt };
  }
  if (backupMs != null && dbMs == null) {
    return { action: 'update', decision: 'backup_has_time', backupUpdatedAt, dbUpdatedAt };
  }
  if (backupMs == null && dbMs != null) {
    return { action: 'skip', decision: 'db_has_time', backupUpdatedAt, dbUpdatedAt };
  }
  return { action: 'conflict', decision: 'no_time_diff_content', backupUpdatedAt, dbUpdatedAt };
}

function buildRentInquiryPayloadFromImport(item, id, createdAt, updatedAt, existingPayload) {
  const base = existingPayload && typeof existingPayload === 'object' ? existingPayload : {};
  const merged = {
    ...base,
    ...item,
    id,
    projektAzonosito: item.projektAzonosito || item.id || id,
    createdAt,
    updatedAt,
    letrehozasDatuma: createdAt,
  };
  const payload = buildRentInquiryPayload(merged, id, createdAt);
  payload.createdAt = createdAt;
  payload.updatedAt = updatedAt;
  payload.letrehozasDatuma = createdAt;
  if (item.routePoints !== undefined) payload.routePoints = item.routePoints;
  if (item.routeGeometry !== undefined) payload.routeGeometry = item.routeGeometry;
  if (item.routeDraft !== undefined) payload.routeDraft = item.routeDraft;
  if (item.adminCalculatedRoute !== undefined) payload.adminCalculatedRoute = item.adminCalculatedRoute;
  return payload;
}

function previewRentImport(inquiries) {
  const currentCount = selectAllRentInquiryIds.all().length;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;
  const items = [];
  const errors = [];
  inquiries.forEach((item) => {
    const id = item && item.id != null ? String(item.id).trim() : '';
    if (!id) {
      skipped += 1;
      errors.push({ id: '', error: 'missing id' });
      return;
    }
    const existing = getRentInquiryById.get(id);
    const verdict = decideRentImportAction(item, existing);
    if (verdict.action === 'import') imported += 1;
    else if (verdict.action === 'update') updated += 1;
    else if (verdict.action === 'conflict') conflicts += 1;
    else skipped += 1;
    items.push({
      id,
      action: verdict.action,
      decision: verdict.decision,
      backupUpdatedAt: verdict.backupUpdatedAt || normalizeRentImportTimestamp(
        item.updatedAt || item.updated_at,
        null,
      ),
      dbUpdatedAt: verdict.dbUpdatedAt || (existing ? normalizeDbTimestamp(existing.updated_at) : null),
    });
  });
  return {
    backupCount: inquiries.length,
    currentCount,
    imported,
    updated,
    skipped,
    conflicts,
    items,
    errors,
  };
}

function applyRentImportRow(item, mode) {
  const id = item && item.id != null ? String(item.id).trim() : '';
  if (!id) return { result: 'error', error: 'missing id' };
  const existing = getRentInquiryById.get(id);
  if (mode === 'legacy') {
    if (existing) return { result: 'skipped', id };
    const nowIso = new Date().toISOString();
    const createdAt = normalizeRentImportTimestamp(
      item.createdAt || item.letrehozasDatuma || item.created_at,
      nowIso,
    );
    const updatedAt = normalizeRentImportTimestamp(item.updatedAt || item.updated_at, createdAt);
    const payload = buildRentInquiryPayloadFromImport(item, id, createdAt, updatedAt, null);
    const row = rentInquiryDbRowFromPayload(payload, id, createdAt, updatedAt);
    insertRentInquiry.run(row);
    return { result: 'imported', id };
  }
  const verdict = decideRentImportAction(item, existing);
  if (verdict.action === 'skip') return { result: 'skipped', id, decision: verdict.decision };
  if (verdict.action === 'conflict') {
    return {
      result: 'conflict',
      id,
      decision: verdict.decision,
      backupUpdatedAt: verdict.backupUpdatedAt,
      dbUpdatedAt: verdict.dbUpdatedAt,
    };
  }
  const nowIso = new Date().toISOString();
  const createdAt = existing
    ? normalizeDbTimestamp(existing.created_at)
    : normalizeRentImportTimestamp(item.createdAt || item.letrehozasDatuma || item.created_at, nowIso);
  const updatedAt = normalizeRentImportTimestamp(item.updatedAt || item.updated_at, createdAt);
  const existingPayload = existing ? parseRentInquiryPayload(existing) : null;
  const payload = buildRentInquiryPayloadFromImport(item, id, createdAt, updatedAt, existingPayload);
  const row = rentInquiryDbRowFromPayload(payload, id, createdAt, updatedAt);
  if (existing) updateRentInquiry.run(row);
  else insertRentInquiry.run(row);
  return {
    result: verdict.action === 'update' ? 'updated' : 'imported',
    id,
    decision: verdict.decision,
  };
}

function parseRentInquiryPayload(row) {
  try {
    const parsed = JSON.parse(row.payload_json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`rent_inquiries payload_json parse failed for id=${row.id}:`, err.message);
    return {};
  }
}

function buildRentInquiryPayload(body, id, nowIso) {
  const customerName = rentPickStr(body, 'customer_name', 'name', 'ordererName');
  const eventDate = rentPickStr(body, 'event_date', 'date');
  const gisMode = normalizeRentGisMode(body);
  const status = normalizeRentStatus(body.status);
  const phone = body.phone != null ? String(body.phone).trim() : '';
  return {
    ...body,
    id,
    projektAzonosito: body.projektAzonosito || body.id || id,
    createdAt: nowIso,
    updatedAt: nowIso,
    letrehozasDatuma: nowIso,
    status,
    date: eventDate,
    event_date: eventDate,
    timeStart: rentPickStr(body, 'timeStart', 'time_start'),
    timeEnd: rentPickStr(body, 'timeEnd', 'time_end'),
    name: customerName,
    customer_name: customerName,
    ordererName: customerName,
    companyName: rentPickStr(body, 'companyName', 'company_name'),
    contact: rentPickStr(body, 'contact', 'contact_name'),
    phone,
    email: rentPickStr(body, 'email'),
    city: rentPickStr(body, 'city'),
    street: rentPickStr(body, 'street'),
    houseNumber: rentPickStr(body, 'houseNumber', 'house_number'),
    locationNote: rentPickStr(body, 'locationNote', 'location_note'),
    lat: body.lat != null && body.lat !== '' ? Number(body.lat) : body.lat,
    lng: body.lng != null && body.lng !== '' ? Number(body.lng) : body.lng,
    headcount: body.headcount != null && body.headcount !== ''
      ? parseInt(body.headcount, 10)
      : (function () {
        const keys = ['passenger_count', 'passengerCount', 'people', 'passengers', 'letszam'];
        for (let i = 0; i < keys.length; i += 1) {
          const v = body[keys[i]];
          if (v != null && v !== '') {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) return n;
          }
        }
        return body.headcount;
      })(),
    bookingType: 'BERLES',
    booking_type: gisMode,
    vehicle: rentPickStr(body, 'vehicle', 'vehicle_id'),
    driver: rentPickStr(body, 'driver', 'driver_id'),
    source: body.source != null ? String(body.source) : body.source,
  };
}

function rentInquiryDbRowFromPayload(payload, id, createdAt, updatedAt) {
  const lat = payload.lat != null && !Number.isNaN(payload.lat) ? payload.lat : null;
  const lng = payload.lng != null && !Number.isNaN(payload.lng) ? payload.lng : null;
  const headcount = payload.headcount != null && !Number.isNaN(payload.headcount)
    ? payload.headcount
    : null;
  return {
    id,
    created_at: createdAt,
    updated_at: updatedAt,
    status: payload.status,
    event_date: payload.event_date || payload.date || null,
    time_start: payload.timeStart || null,
    time_end: payload.timeEnd || null,
    customer_name: payload.customer_name || payload.name || null,
    company_name: payload.companyName || null,
    contact_name: payload.contact || null,
    phone: payload.phone || null,
    email: payload.email || null,
    city: payload.city || null,
    street: payload.street || null,
    house_number: payload.houseNumber || null,
    location_note: payload.locationNote || null,
    lat,
    lng,
    headcount,
    vehicle_id: payload.vehicle || payload.vehicle_id || null,
    driver_id: payload.driver || payload.driver_id || null,
    business_type: 'BERLES',
    gis_mode: payload.booking_type || 'single_location',
    source: payload.source || null,
    payload_json: JSON.stringify(payload),
  };
}

function validateRentInquiryPost(body) {
  if (!body || typeof body !== 'object') return 'Invalid request body';
  if (!rentPickStr(body, 'customer_name', 'name', 'ordererName')) {
    return 'customer_name or name is required';
  }
  if (body.phone == null || String(body.phone).trim() === '') return 'phone is required';
  if (!rentPickStr(body, 'event_date', 'date')) return 'event_date or date is required';
  return null;
}

function mergeRentInquiryPatch(existingPayload, existingId, body) {
  const nowIso = new Date().toISOString();
  const merged = {
    ...existingPayload,
    ...body,
    id: existingId,
    projektAzonosito: existingPayload.projektAzonosito || existingId,
    updatedAt: nowIso,
    bookingType: 'BERLES',
  };
  if ('status' in body) merged.status = normalizeRentStatus(body.status);
  if ('event_date' in body || 'date' in body) {
    const d = rentPickStr(body, 'event_date', 'date');
    merged.date = d;
    merged.event_date = d;
  }
  if ('time_start' in body || 'timeStart' in body) {
    merged.timeStart = rentPickStr(body, 'timeStart', 'time_start');
  }
  if ('time_end' in body || 'timeEnd' in body) {
    merged.timeEnd = rentPickStr(body, 'timeEnd', 'time_end');
  }
  if ('customer_name' in body || 'name' in body || 'ordererName' in body) {
    const n = rentPickStr(body, 'customer_name', 'name', 'ordererName');
    merged.name = n;
    merged.customer_name = n;
    merged.ordererName = n;
  }
  if ('company_name' in body || 'companyName' in body) {
    merged.companyName = rentPickStr(body, 'companyName', 'company_name');
  }
  if ('contact_name' in body || 'contact' in body) {
    merged.contact = rentPickStr(body, 'contact', 'contact_name');
  }
  if ('phone' in body) merged.phone = String(body.phone).trim();
  if ('email' in body) merged.email = rentPickStr(body, 'email');
  if ('city' in body) merged.city = rentPickStr(body, 'city');
  if ('street' in body) merged.street = rentPickStr(body, 'street');
  if ('house_number' in body || 'houseNumber' in body) {
    merged.houseNumber = rentPickStr(body, 'houseNumber', 'house_number');
  }
  if ('location_note' in body || 'locationNote' in body) {
    merged.locationNote = rentPickStr(body, 'locationNote', 'location_note');
  }
  if ('lat' in body) {
    merged.lat = body.lat != null && body.lat !== '' ? Number(body.lat) : body.lat;
  }
  if ('lng' in body) {
    merged.lng = body.lng != null && body.lng !== '' ? Number(body.lng) : body.lng;
  }
  if ('headcount' in body) {
    merged.headcount = body.headcount != null && body.headcount !== ''
      ? parseInt(body.headcount, 10)
      : body.headcount;
  }
  if ('vehicle' in body || 'vehicle_id' in body) {
    merged.vehicle = rentPickStr(body, 'vehicle', 'vehicle_id');
  }
  if ('driver' in body || 'driver_id' in body) {
    merged.driver = rentPickStr(body, 'driver', 'driver_id');
  }
  if ('booking_type' in body || 'gis_mode' in body) {
    merged.booking_type = normalizeRentGisMode(body);
  }
  if ('source' in body) merged.source = body.source != null ? String(body.source) : body.source;
  return merged;
}

function rowToRentInquiry(row) {
  const payload = parseRentInquiryPayload(row);
  const customerName = row.customer_name || payload.name || payload.customer_name || payload.ordererName || '';
  const eventDate = row.event_date || payload.date || payload.event_date || '';
  const gisMode = row.gis_mode || payload.booking_type || 'single_location';
  const street = row.street || payload.street || '';
  const houseNumber = row.house_number || payload.houseNumber || '';
  return {
    ...payload,
    id: row.id,
    projektAzonosito: payload.projektAzonosito || payload.id || row.id,
    createdAt: normalizeDbTimestamp(row.created_at),
    updatedAt: normalizeDbTimestamp(row.updated_at),
    letrehozasDatuma: normalizeDbTimestamp(row.created_at),
    status: row.status,
    date: eventDate,
    event_date: eventDate,
    timeStart: row.time_start || payload.timeStart || '',
    timeEnd: row.time_end || payload.timeEnd || '',
    name: customerName,
    customer_name: customerName,
    ordererName: customerName,
    companyName: row.company_name || payload.companyName || '',
    contact: row.contact_name || payload.contact || '',
    phone: formatHuPhoneDisplay(row.phone || payload.phone),
    email: row.email || payload.email || '',
    city: row.city || payload.city || '',
    street,
    houseNumber,
    address: [street, houseNumber].filter(Boolean).join(' ').trim() || payload.address || '',
    locationNote: row.location_note || payload.locationNote || '',
    lat: row.lat != null ? row.lat : payload.lat,
    lng: row.lng != null ? row.lng : payload.lng,
    headcount: row.headcount != null ? row.headcount : payload.headcount,
    bookingType: 'BERLES',
    booking_type: gisMode,
    vehicle: row.vehicle_id || payload.vehicle || '',
    driver: row.driver_id || payload.driver || '',
    source: row.source || payload.source || '',
  };
}

function normalizePublicReservation(body) {
  if (!body || typeof body !== 'object') return null;
  const phone = normalizeHuPhone(body.phone);
  const time = body.time != null ? String(body.time).trim() : '';
  const stopName = body.stop_name != null ? String(body.stop_name).trim()
    : body.stop != null ? String(body.stop).trim() : '';
  if (!phone || !time || !stopName) return null;
  const count = Math.max(1, parseInt(body.count != null ? body.count : body.passenger_count, 10) || 1);
  return {
    id: bookingId('rsv'),
    time,
    stop_name: stopName,
    stop_id: body.stop_id != null ? String(body.stop_id).trim() : null,
    city: body.city != null ? String(body.city).trim() : null,
    passenger_count: count,
    phone,
    status: 'new',
    reservation_type: body.reservation_type != null ? String(body.reservation_type).trim() : 'scheduled',
    note: body.note != null ? String(body.note).trim() : '',
  };
}

function normalizePublicBoarding(body) {
  if (!body || typeof body !== 'object') return null;
  const phone = normalizeHuPhone(body.phone);
  if (!phone) return null;
  const lat = body.lat != null ? Number(body.lat) : null;
  const lng = body.lng != null ? Number(body.lng) : null;
  const isRoutePickup = body.boarding_type === 'route'
    || body.source === 'route'
    || (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng));
  let stopName = body.stop_name != null ? String(body.stop_name).trim() : '';
  if (isRoutePickup && !stopName) stopName = 'Útvonal menti felszállás';
  if (!isRoutePickup && !stopName) return null;
  if (isRoutePickup && (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng))) return null;
  const count = Math.max(1, parseInt(body.count != null ? body.count : body.passenger_count, 10) || 1);
  return {
    id: bookingId('brd'),
    stop_name: stopName,
    stop_id: body.stop_id != null ? String(body.stop_id).trim() : null,
    city: body.city != null ? String(body.city).trim() : null,
    passenger_count: count,
    phone,
    lat: isRoutePickup ? lat : null,
    lng: isRoutePickup ? lng : null,
    created_at: new Date().toISOString(),
  };
}

const insertEvent = db.prepare(`
  INSERT INTO events (id, type, trip, shift, timestamp, lat, lng, payload_json)
  VALUES (@id, @type, @trip, @shift, @timestamp, @lat, @lng, @payload_json)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    trip = excluded.trip,
    shift = excluded.shift,
    timestamp = excluded.timestamp,
    lat = excluded.lat,
    lng = excluded.lng,
    payload_json = excluded.payload_json
`);

const selectRecentEvents = db.prepare(`
  SELECT id, type, trip, shift, timestamp, lat, lng, payload_json, created_at
  FROM events
  ORDER BY timestamp DESC, created_at DESC
  LIMIT ?
`);

const selectEventsChronological = db.prepare(`
  SELECT id, type, trip, shift, timestamp, lat, lng, payload_json, created_at
  FROM events
  ORDER BY timestamp ASC, created_at ASC
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (id, trip_id, vehicle_id, type, title, description, lat, lng, status)
  VALUES (@id, @trip_id, @vehicle_id, @type, @title, @description, @lat, @lng, @status)
`);

const selectTasks = db.prepare(`
  SELECT id, created_at, accepted_at, picked_up_at, done_at, cancelled_at,
    trip_id, vehicle_id, type, title, description, lat, lng, status
  FROM tasks
  WHERE (@status IS NULL OR status = @status)
  ORDER BY created_at DESC
  LIMIT @limit
`);

const updateTaskStatusStmt = db.prepare(`
  UPDATE tasks SET status = @status WHERE id = @id
`);

const updateTaskStmt = db.prepare(`
  UPDATE tasks SET
    trip_id = @trip_id,
    vehicle_id = @vehicle_id,
    type = @type,
    title = @title,
    description = @description,
    lat = @lat,
    lng = @lng,
    status = @status
  WHERE id = @id
`);

const deleteTaskStmt = db.prepare('DELETE FROM tasks WHERE id = @id');

function selectTasksFiltered(statuses, limit) {
  if (!statuses || statuses.length === 0) {
    return selectTasks.all({ status: null, limit });
  }
  if (statuses.length === 1) {
    return selectTasks.all({ status: statuses[0], limit });
  }
  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, created_at, trip_id, vehicle_id, type, title, description, lat, lng, status
    FROM tasks
    WHERE status IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...statuses, limit);
}

function getActiveDriverSessions() {
  const rows = selectEventsChronological.all();
  const open = new Map();
  const lastTrack = new Map();

  for (const row of rows) {
    const shift = row.shift != null ? String(row.shift).trim() : '';
    if (!shift) continue;
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }
    const type = String(row.type || '').trim();
    if (type === 'track' || type === 'auto_track') {
      if (row.lat != null && row.lng != null) {
        const prev = lastTrack.get(shift);
        if (!prev || String(row.timestamp || '') >= String(prev.timestamp || '')) {
          lastTrack.set(shift, { lat: row.lat, lng: row.lng, timestamp: row.timestamp });
        }
      }
    }
    if (type === 'muszak_inditas') {
      open.set(shift, {
        shift_id: shift,
        driver_id: payload.driver_id || null,
        driver_name: payload.driver_name || null,
        vehicle_id: payload.vehicle_id || null,
        vehicle_name: payload.vehicle_name || null,
        city: payload.city || null,
        started_at: row.timestamp,
        last_lat: row.lat,
        last_lng: row.lng,
      });
      continue;
    }
    if (type === 'shift_end') {
      open.delete(shift);
      lastTrack.delete(shift);
    }
  }

  return Array.from(open.values()).map((s) => {
    const tr = lastTrack.get(s.shift_id);
    if (tr) {
      return {
        ...s,
        last_lat: tr.lat,
        last_lng: tr.lng,
        last_track_at: tr.timestamp,
      };
    }
    return s;
  }).sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
}

function getActiveTrips() {
  const rows = selectEventsChronological.all();
  let openTrip = null;

  for (const row of rows) {
    const tripId = row.trip;
    if (!tripId) continue;

    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }

    if (TRIP_START_TYPES.has(row.type)) {
      openTrip = {
        trip: tripId,
        shift: row.shift || payload.shift || null,
        started_at: row.timestamp,
        driver_id: payload.driver_id || null,
        driver_name: payload.driver_name || null,
        vehicle_id: payload.vehicle_id || null,
        vehicle_name: payload.vehicle_name || null,
        city: payload.city || null,
        schedule: payload.schedule || null,
        start_lat: row.lat,
        start_lng: row.lng,
        active: true,
      };
      continue;
    }

    if (TRIP_END_TYPES.has(row.type)) {
      if (!openTrip) continue;
      if (row.trip === openTrip.trip) {
        openTrip = null;
      }
    }
  }

  return openTrip ? [openTrip] : [];
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/vendor', express.static(path.join(__dirname, 'vendor')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/events', (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : [body];
  const saved = [];
  const errors = [];

  const insertMany = db.transaction((list) => {
    for (let i = 0; i < list.length; i += 1) {
      const normalized = normalizeIncomingEvent(list[i]);
      if (!normalized) {
        errors.push({ index: i, message: 'Invalid event (type required)' });
        continue;
      }
      insertEvent.run(normalized);
      saved.push(normalized.id);
    }
  });

  try {
    insertMany(items);
    items.forEach((item) => {
      const normalized = normalizeIncomingEvent(item);
      if (!normalized) return;
      const shiftId = normalized.shift != null ? String(normalized.shift).trim() : '';
      if (!shiftId) return;
      const type = String(normalized.type || '').trim();
      if (type === 'track' || type === 'auto_track') {
        touchActiveShiftActivity(shiftId, 'gps', normalized.timestamp);
      }
    });
    res.status(201).json({
      ok: true,
      received: items.length,
      saved: saved.length,
      ids: saved,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('POST /api/events failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to store events' });
  }
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 3000);
  const rows = selectRecentEvents.all(limit);
  res.json({
    ok: true,
    count: rows.length,
    events: rows.map(rowToClient),
  });
});

function activeTripIdsFromEvents(events) {
  const open = new Map();
  const sorted = (events || []).slice().sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  sorted.forEach((ev) => {
    const trip = ev.trip != null ? String(ev.trip).trim() : '';
    if (!trip) return;
    const type = String(ev.type || '').trim();
    if (TRIP_START_TYPES.has(type)) open.set(trip, true);
    if (TRIP_END_TYPES.has(type)) open.delete(trip);
  });
  return open;
}

function extractTripStartMeta(ev) {
  const p = ev.payload || ev;
  return {
    vehicle_id: p.vehicle_id || ev.vehicle_id || null,
    vehicle_name: p.vehicle_name || ev.vehicle_name || null,
    city: p.city || null,
  };
}

function buildTripStartMap(events) {
  const tripStart = {};
  (events || []).forEach((ev) => {
    const trip = ev.trip != null ? String(ev.trip).trim() : '';
    if (!trip) return;
    const type = String(ev.type || '').trim();
    if (!TRIP_START_TYPES.has(type)) return;
    tripStart[trip] = extractTripStartMeta(ev);
  });
  return tripStart;
}

/** Kanonikus nyitott járatok – ugyanaz a logika mint buildVehiclePositionsFromEvents / public. */
function getOpenTripsFromFullEvents() {
  const allEvents = selectEventsChronological.all().map(rowToClient);
  const openIds = activeTripIdsFromEvents(allEvents);
  return [...openIds.keys()].map((tripId) => {
    let startEv = null;
    allEvents.forEach((ev) => {
      if (String(ev.trip || '').trim() !== tripId) return;
      if (!TRIP_START_TYPES.has(String(ev.type || '').trim())) return;
      startEv = ev;
    });
    const p = (startEv && startEv.payload) ? startEv.payload : (startEv || {});
    return {
      trip: tripId,
      shift: (startEv && startEv.shift) || p.shift || null,
      vehicle_id: p.vehicle_id || (startEv && startEv.vehicle_id) || null,
      vehicle_name: p.vehicle_name || (startEv && startEv.vehicle_name) || null,
      driver_id: p.driver_id || null,
      driver_name: p.driver_name || null,
      started_at: (startEv && startEv.timestamp) || p.start_time || null,
    };
  });
}

function ingestLatestTrack(byTrip, ev) {
  const trip = ev.trip != null ? String(ev.trip).trim() : '';
  if (!trip) return;
  const type = String(ev.type || '').trim();
  if (type !== 'track' && type !== 'auto_track') return;
  if (ev.lat == null || ev.lng == null) return;
  const ts = ev.timestamp || '';
  if (!byTrip[trip] || ts > (byTrip[trip].timestamp || '')) {
    byTrip[trip] = ev;
  }
}

const ETA_FALLBACK_SPEED_KMH = 15;

function recentSpeedKmhForTrip(tripId, events, maxPoints = 6) {
  const pts = (events || [])
    .filter((e) => String(e.trip || '').trim() === tripId)
    .filter((e) => e.type === 'track' || e.type === 'auto_track')
    .filter((e) => e.lat != null && e.lng != null)
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  if (pts.length < 2) {
    const last = pts[pts.length - 1];
    if (!last) return null;
    const p = last.payload || {};
    const sp = p.speed != null ? p.speed : last.speed;
    const n = Number(sp);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  const slice = pts.slice(-maxPoints);
  let totalDist = 0;
  let totalMs = 0;
  for (let i = 1; i < slice.length; i += 1) {
    totalDist += haversineMeters(slice[i - 1].lat, slice[i - 1].lng, slice[i].lat, slice[i].lng);
    const t0 = new Date(slice[i - 1].timestamp).getTime();
    const t1 = new Date(slice[i].timestamp).getTime();
    if (!Number.isNaN(t0) && !Number.isNaN(t1) && t1 > t0) {
      totalMs += t1 - t0;
    }
  }
  if (totalMs < 1000 || totalDist < 5) return null;
  const kmh = (totalDist / (totalMs / 1000)) * 3.6;
  if (kmh < 1 || kmh > 120) return null;
  return Math.round(kmh);
}

function estimateEtaMinutes(distanceM, speedKmh) {
  if (distanceM == null || distanceM <= 40) return 0;
  const speed = speedKmh != null && speedKmh > 1 ? speedKmh : ETA_FALLBACK_SPEED_KMH;
  return (distanceM / 1000) / speed * 60;
}

function formatEtaBandLabel(minutes) {
  if (minutes == null || minutes <= 0) return 'Megérkezett';
  if (minutes <= 5) return 'Kb. 3-5 percen belül érkezik';
  if (minutes <= 10) return 'Kb. 5-10 percen belül érkezik';
  if (minutes <= 15) return 'Kb. 10-15 percen belül érkezik';
  return null;
}

function passengersForTrip(trip, events) {
  let passengers = 0;
  (events || []).forEach((e) => {
    if (String(e.trip || '').trim() !== trip) return;
    const t = String(e.type || '').trim();
    const p = e.payload || e;
    if (t === 'passenger' || t === 'utas') {
      if (p.passengers_current != null) passengers = p.passengers_current;
      else if (e.passengers_current != null) passengers = e.passengers_current;
    }
    if (TRIP_END_TYPES.has(t) && p.passengers_final != null) {
      passengers = p.passengers_final;
    }
  });
  return passengers;
}

function buildVehiclePositionsFromEvents(recentEvents) {
  const vehicles = readVehicles();
  const capById = {};
  const cityByVehicle = {};
  vehicles.forEach((v) => {
    const id = v.vehicle_id || v.id;
    if (!id) return;
    capById[id] = Math.max(1, parseInt(v.capacity, 10) || REPORT_DEFAULT_CAPACITY);
    if (v.local) cityByVehicle[id] = v.local;
  });

  const allEvents = selectEventsChronological.all().map(rowToClient);
  const activeTrips = activeTripIdsFromEvents(allEvents);
  const tripStart = buildTripStartMap(allEvents);

  const byTrip = {};
  (recentEvents || []).forEach((ev) => ingestLatestTrack(byTrip, ev));
  activeTrips.forEach((_, trip) => {
    if (byTrip[trip]) return;
    allEvents.forEach((ev) => {
      if (String(ev.trip || '').trim() !== trip) return;
      ingestLatestTrack(byTrip, ev);
    });
  });

  return Array.from(activeTrips.keys())
    .filter((trip) => byTrip[trip])
    .map((trip) => {
      const ev = byTrip[trip];
      const meta = tripStart[trip] || {};
      const vehicleId = meta.vehicle_id || trip;
      const cap = capById[vehicleId] || REPORT_DEFAULT_CAPACITY;
      const passengers = passengersForTrip(trip, allEvents);
      const free = Math.max(0, cap - passengers);
      const vehicleLocal = cityByVehicle[vehicleId] || null;
      const city = vehicleLocal || meta.city || null;
      const cityId = primaryPublicCityId({
        vehicle_local: vehicleLocal,
        city: meta.city,
        lat: ev.lat,
        lng: ev.lng,
      });
      const speedKmh = recentSpeedKmhForTrip(trip, allEvents);
      return {
        vehicle: vehicleId,
        vehicle_name: meta.vehicle_name || vehicleId,
        trip,
        city,
        city_id: cityId,
        vehicle_local: vehicleLocal,
        passengers,
        free,
        free_seats: free,
        capacity: cap,
        lat: ev.lat,
        lng: ev.lng,
        last_gps: ev.timestamp || null,
        speed_kmh: speedKmh,
        live: true,
      };
    });
}

app.get('/api/vehicles', (_req, res) => {
  const vehicles = readVehicles();
  res.json({ ok: true, count: vehicles.length, vehicles });
});

app.get('/api/drivers', (_req, res) => {
  const drivers = readDrivers();
  res.json({ ok: true, count: drivers.length, drivers });
});

app.get('/api/config', (_req, res) => {
  try {
    const config = buildConfigResponse();
    res.json({ ok: true, ...config });
  } catch (err) {
    console.error('GET /api/config failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load config' });
  }
});

function readSchedulesData() {
  try {
    if (!fs.existsSync(schedulesPath)) return {};
    const raw = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    console.error('[schedules] read failed:', err);
    return {};
  }
}

app.get('/api/schedules', (req, res) => {
  try {
    const cityId = String(req.query.city || '').trim().toLowerCase();
    const all = readSchedulesData();
    const schedules = cityId ? (all[cityId] || []) : all;
    res.json({ ok: true, schedules });
  } catch (err) {
    console.error('GET /api/schedules failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load schedules' });
  }
});

app.post('/api/shifts/start', (req, res) => {
  const body = req.body || {};
  const shiftId = String(body.shift_id || '').trim();
  const vehicleId = String(body.vehicle_id || '').trim();
  const driverId = String(body.driver_id || '').trim();
  const driverName = body.driver_name != null ? String(body.driver_name).trim() : '';
  const route = body.route != null ? String(body.route).trim() : '';
  const city = body.city != null ? String(body.city).trim() : '';
  const pin = body.pin != null ? String(body.pin).trim() : '';
  if (!shiftId || !vehicleId || !driverId) {
    return res.status(400).json({ ok: false, error: 'shift_id, vehicle_id, driver_id required' });
  }
  if (!validateConfigPin(driverId, pin)) {
    return res.status(403).json({ ok: false, error: 'Hibás PIN' });
  }
  try {
    const existing = findOpenShiftByVehicle(vehicleId);
    if (existing && existing.shift_id !== shiftId) {
      return res.status(409).json({
        ok: false,
        error: 'A kiválasztott jármű már használatban van.',
        vehicle_id: vehicleId,
        active_shift_id: existing.shift_id,
      });
    }
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO active_shifts (
        shift_id, vehicle_id, driver_id, driver_name, route, city, status, started_at, last_heartbeat_at
      ) VALUES (
        @shift_id, @vehicle_id, @driver_id, @driver_name, @route, @city, 'ACTIVE', @started_at, @started_at
      )
      ON CONFLICT(shift_id) DO UPDATE SET
        vehicle_id = excluded.vehicle_id,
        driver_id = excluded.driver_id,
        driver_name = excluded.driver_name,
        route = excluded.route,
        city = excluded.city,
        status = 'ACTIVE',
        closed_at = NULL,
        last_heartbeat_at = excluded.last_heartbeat_at
    `).run({
      shift_id: shiftId,
      vehicle_id: vehicleId,
      driver_id: driverId,
      driver_name: driverName || null,
      route: route || null,
      city: city || null,
      started_at: now,
    });
    res.status(201).json({ ok: true, shift_id: shiftId, vehicle_id: vehicleId });
  } catch (err) {
    console.error('POST /api/shifts/start failed:', err);
    res.status(500).json({ ok: false, error: 'Shift start failed' });
  }
});

app.post('/api/shifts/end', (req, res) => {
  const body = req.body || {};
  const shiftId = String(body.shift_id || body.shift || '').trim();
  if (!shiftId) {
    return res.status(400).json({ ok: false, error: 'shift_id required' });
  }
  try {
    closeActiveShiftRow(shiftId, 'CLOSED');
    res.json({ ok: true, shift_id: shiftId, closed: true });
  } catch (err) {
    console.error('POST /api/shifts/end failed:', err);
    res.status(500).json({ ok: false, error: 'Shift end failed' });
  }
});

app.post('/api/shifts/heartbeat', (req, res) => {
  const body = req.body || {};
  const shiftId = String(body.shift_id || body.shift || '').trim();
  if (!shiftId) {
    return res.status(400).json({ ok: false, error: 'shift_id required' });
  }
  try {
    touchActiveShiftActivity(shiftId, 'heartbeat');
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/shifts/heartbeat failed:', err);
    res.status(500).json({ ok: false, error: 'Heartbeat failed' });
  }
});

app.get('/api/vehicle-positions', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1500, 1), 500);
  const rows = selectRecentEvents.all(limit);
  const events = rows.map(rowToClient);
  let positions = buildVehiclePositionsFromEvents(events);
  const city = req.query.city != null ? String(req.query.city).trim() : '';
  if (city) {
    positions = filterRowsByCity(positions, city);
  }
  res.json({ ok: true, count: positions.length, vehicles: positions });
});

app.put('/api/vehicles', (req, res) => {
  const body = req.body;
  const list = Array.isArray(body) ? body : (body && body.vehicles);
  if (!Array.isArray(list)) {
    return res.status(400).json({ ok: false, error: 'vehicles array required' });
  }
  try {
    const saved = writeVehicles(list);
    res.json({ ok: true, count: saved.length, vehicles: saved });
  } catch (err) {
    console.error('PUT /api/vehicles failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save vehicles' });
  }
});

app.get('/api/admin/trips', (_req, res) => {
  const trips = getActiveTrips();
  res.json({
    ok: true,
    count: trips.length,
    trips,
  });
});

app.get('/api/admin/active-drivers', (_req, res) => {
  try {
    const shifts = getActiveShiftsFromDb();
    const drivers = shifts;
    res.json({ ok: true, count: drivers.length, drivers, shifts });
  } catch (err) {
    console.error('GET /api/admin/active-drivers failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load active drivers' });
  }
});

app.get('/api/admin/open-trips', (_req, res) => {
  try {
    const trips = getOpenTripsFromFullEvents();
    res.json({ ok: true, count: trips.length, trips });
  } catch (err) {
    console.error('GET /api/admin/open-trips failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load open trips' });
  }
});

app.get('/api/admin/active-shifts', (_req, res) => {
  try {
    const shifts = getActiveShiftsFromDb();
    res.json({ ok: true, count: shifts.length, shifts });
  } catch (err) {
    console.error('GET /api/admin/active-shifts failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load active shifts' });
  }
});

app.post('/api/admin/active-shifts/:shiftId/close', (req, res) => {
  const shiftId = String(req.params.shiftId || '').trim();
  if (!shiftId) return res.status(400).json({ ok: false, error: 'shiftId required' });
  try {
    const row = db.prepare('SELECT * FROM active_shifts WHERE shift_id = ?').get(shiftId);
    db.prepare(`
      INSERT INTO driver_kicks (shift_id, kicked_at, kicked_by)
      VALUES (@shift_id, datetime('now'), @kicked_by)
      ON CONFLICT(shift_id) DO UPDATE SET kicked_at = datetime('now'), kicked_by = @kicked_by
    `).run({ shift_id: shiftId, kicked_by: 'admin_close_shift' });
    closeActiveShiftRow(shiftId, 'CLOSED');
    const kickEnd = normalizeIncomingEvent({
      id: `admin_close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'shift_end',
      shift: shiftId,
      timestamp: new Date().toISOString(),
      driver_id: row ? row.driver_id : null,
      driver_name: row ? row.driver_name : null,
      vehicle_id: row ? row.vehicle_id : null,
      note: 'Admin műszak lezárás',
      source: 'admin_close_shift',
    });
    if (kickEnd) insertEvent.run(kickEnd);
    res.json({ ok: true, shift_id: shiftId, closed: true });
  } catch (err) {
    console.error('POST close shift failed:', err);
    res.status(500).json({ ok: false, error: 'Close shift failed' });
  }
});

app.post('/api/admin/active-shifts/:shiftId/close-trip', (req, res) => {
  const shiftId = String(req.params.shiftId || '').trim();
  if (!shiftId) return res.status(400).json({ ok: false, error: 'shiftId required' });
  try {
    const trip = getOpenTripsFromFullEvents().find((t) => String(t.shift || '') === shiftId);
    if (!trip) {
      return res.status(400).json({ ok: false, error: 'Nincs nyitott járat ehhez a műszakhoz' });
    }
    const tripEnd = normalizeIncomingEvent({
      id: `admin_trip_close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'trip_end',
      trip: trip.trip,
      shift: shiftId,
      timestamp: new Date().toISOString(),
      driver_id: trip.driver_id,
      vehicle_id: trip.vehicle_id,
      note: 'Admin járat lezárás',
      source: 'admin_close_trip',
    });
    if (tripEnd) insertEvent.run(tripEnd);
    res.json({ ok: true, shift_id: shiftId, trip_id: trip.trip, closed: true });
  } catch (err) {
    console.error('POST close trip failed:', err);
    res.status(500).json({ ok: false, error: 'Close trip failed' });
  }
});

app.post('/api/admin/active-shifts/:shiftId/technical-issue', (req, res) => {
  const shiftId = String(req.params.shiftId || '').trim();
  if (!shiftId) return res.status(400).json({ ok: false, error: 'shiftId required' });
  try {
    db.prepare(`
      UPDATE active_shifts SET status = 'TECHNICAL_ISSUE'
      WHERE shift_id = @shift_id AND closed_at IS NULL
    `).run({ shift_id: shiftId });
    res.json({ ok: true, shift_id: shiftId, status: 'TECHNICAL_ISSUE' });
  } catch (err) {
    console.error('POST technical-issue failed:', err);
    res.status(500).json({ ok: false, error: 'Technical issue failed' });
  }
});

app.post('/api/admin/vehicles/:vehicleId/release', (req, res) => {
  const vehicleId = String(req.params.vehicleId || '').trim();
  if (!vehicleId) return res.status(400).json({ ok: false, error: 'vehicleId required' });
  try {
    const openRows = db.prepare(`
      SELECT * FROM active_shifts
      WHERE vehicle_id = @vehicle_id AND closed_at IS NULL
    `).all({ vehicle_id: vehicleId });
    openRows.forEach((row) => {
      const shiftId = String(row.shift_id || '').trim();
      if (!shiftId) return;
      const shiftEnd = normalizeIncomingEvent({
        id: `admin_close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'shift_end',
        shift: shiftId,
        timestamp: new Date().toISOString(),
        driver_id: row.driver_id || null,
        driver_name: row.driver_name || null,
        vehicle_id: row.vehicle_id || null,
        note: 'Admin műszak lezárás',
        source: 'admin_close_shift',
      });
      if (shiftEnd) insertEvent.run(shiftEnd);
    });
    releaseVehicleLock(vehicleId);
    res.json({ ok: true, vehicle_id: vehicleId, released: true });
  } catch (err) {
    console.error('POST vehicle release failed:', err);
    res.status(500).json({ ok: false, error: 'Vehicle release failed' });
  }
});

app.post('/api/admin/active-drivers/:shiftId/kick', (req, res) => {
  const shiftId = String(req.params.shiftId || '').trim();
  if (!shiftId) {
    return res.status(400).json({ ok: false, error: 'shiftId required' });
  }
  try {
    const active = getActiveDriverSessions();
    const match = active.find((d) => d.shift_id === shiftId);
    db.prepare(`
      INSERT INTO driver_kicks (shift_id, kicked_at, kicked_by)
      VALUES (@shift_id, datetime('now'), @kicked_by)
      ON CONFLICT(shift_id) DO UPDATE SET kicked_at = datetime('now'), kicked_by = @kicked_by
    `).run({
      shift_id: shiftId,
      kicked_by: req.body && req.body.by ? String(req.body.by).trim() : 'admin',
    });
    const kickEnd = normalizeIncomingEvent({
      id: `admin_kick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'shift_end',
      shift: shiftId,
      timestamp: new Date().toISOString(),
      city: match && match.city ? match.city : null,
      driver_id: match && match.driver_id ? match.driver_id : null,
      driver_name: match && match.driver_name ? match.driver_name : null,
      vehicle_id: match && match.vehicle_id ? match.vehicle_id : null,
      note: 'Admin kiléptetés',
      source: 'admin_kick',
    });
    if (kickEnd) insertEvent.run(kickEnd);
    closeActiveShiftRow(shiftId, 'CLOSED');
    res.json({ ok: true, shift_id: shiftId, kicked: true });
  } catch (err) {
    console.error('POST /api/admin/active-drivers kick failed:', err);
    res.status(500).json({ ok: false, error: 'Kick failed' });
  }
});

app.get('/api/driver/shift-kick', (req, res) => {
  const shiftId = String(req.query.shift || '').trim();
  if (!shiftId) {
    return res.json({ ok: true, kicked: false });
  }
  try {
    const row = db.prepare('SELECT shift_id, kicked_at FROM driver_kicks WHERE shift_id = ?').get(shiftId);
    res.json({ ok: true, kicked: !!row, kicked_at: row ? row.kicked_at : null });
  } catch (err) {
    console.error('GET /api/driver/shift-kick failed:', err);
    res.status(500).json({ ok: false, error: 'Check failed' });
  }
});

app.delete('/api/driver/shift-kick', (req, res) => {
  const shiftId = String((req.query && req.query.shift) || (req.body && req.body.shift) || '').trim();
  if (!shiftId) {
    return res.status(400).json({ ok: false, error: 'shift required' });
  }
  try {
    db.prepare('DELETE FROM driver_kicks WHERE shift_id = ?').run(shiftId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/driver/shift-kick failed:', err);
    res.status(500).json({ ok: false, error: 'Ack failed' });
  }
});

app.get('/api/tasks', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const statuses = parseTaskStatusQuery(req.query.status);
  const rows = selectTasksFiltered(statuses, limit);
  res.json({
    ok: true,
    count: rows.length,
    tasks: rows.map(rowToTaskClient),
  });
});

app.patch('/api/tasks/:id/status', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ ok: false, error: 'id required' });
  }
  const status = req.body && req.body.status != null ? String(req.body.status).trim() : '';
  if (!TASK_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, error: 'status must be pending, accepted, picked_up, done, or cancelled' });
  }
  try {
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    const prevStatus = String(existing.status || '').trim();
    if (status === 'picked_up' && prevStatus === 'picked_up') {
      return res.json({ ok: true, task: rowToTaskClient(existing) });
    }
    if (status === 'picked_up' && prevStatus !== 'accepted') {
      return res.status(409).json({
        ok: false,
        error: 'picked_up only allowed from accepted',
        current_status: prevStatus,
      });
    }
    const tsCol = TASK_STATUS_TS_COLUMN[status];
    const now = new Date().toISOString();
    let result;
    if (tsCol) {
      result = db.prepare(`UPDATE tasks SET status = ?, ${tsCol} = ? WHERE id = ?`).run(status, now, id);
    } else {
      result = updateTaskStatusStmt.run({ id, status });
    }
    if (!result.changes) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const client = rowToTaskClient(row);
    console.log('[tasks] PATCH status', id, prevStatus, '->', client.status);
    res.json({ ok: true, task: client });
  } catch (err) {
    console.error('PATCH /api/tasks/:id/status failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to update task status' });
  }
});

app.patch('/api/tasks/:id', (req, res) => {
  const paramId = String(req.params.id || '').trim();
  const normalized = normalizeTaskUpdate(Object.assign({}, req.body, { id: paramId }));
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'invalid task update (title required)' });
  }
  try {
    const result = updateTaskStmt.run(normalized);
    if (!result.changes) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(paramId);
    res.json({ ok: true, task: rowToTaskClient(row) });
  } catch (err) {
    console.error('PATCH /api/tasks/:id failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to update task' });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ ok: false, error: 'id required' });
  }
  try {
    const result = deleteTaskStmt.run({ id });
    if (!result.changes) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('DELETE /api/tasks/:id failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete task' });
  }
});

app.post('/api/tasks', (req, res) => {
  const normalized = normalizeIncomingTask(req.body);
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'title required' });
  }
  try {
    insertTask.run(normalized);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(normalized.id);
    res.status(201).json({ ok: true, task: rowToTaskClient(row) });
  } catch (err) {
    console.error('POST /api/tasks failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to store task' });
  }
});

app.get('/api/driver/bookings', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const city = req.query.city != null ? String(req.query.city).trim() : '';
  try {
    const scheduled = filterRowsByCity(selectScheduled.all(limit), city).map(rowToScheduled);
    const boarding = filterRowsByCity(selectBoardingActive.all(limit), city).map(rowToBoarding);
    const custom = filterRowsByCity(selectCustom.all(limit), city).map(rowToCustom);
    res.json({ ok: true, scheduled, boarding, custom });
  } catch (err) {
    console.error('GET /api/driver/bookings failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load bookings' });
  }
});

app.patch('/api/driver/bookings/scheduled/:id/seen', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  try {
    markScheduledSeen.run({ id, seen_at: new Date().toISOString() });
    const updated = getScheduledById.get(id);
    if (!updated) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, reservation: rowToScheduled(updated) });
  } catch (err) {
    console.error('PATCH scheduled seen failed:', err);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

app.patch('/api/driver/bookings/boarding/:id/respond', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const response = req.body && req.body.response != null ? String(req.body.response).trim() : '';
  if (!BOARDING_DRIVER_RESPONSES.has(response)) {
    return res.status(400).json({ ok: false, error: 'response must be can_stop, full, unsafe, not_on_route, or other' });
  }
  try {
    const result = respondBoarding.run({ id, driver_response: response });
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not found or already handled' });
    const updated = getBoardingById.get(id);
    res.json({ ok: true, boarding: rowToBoarding(updated) });
  } catch (err) {
    console.error('PATCH boarding respond failed:', err);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

app.get('/api/admin/bookings', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  try {
    res.json({
      ok: true,
      scheduled: selectScheduled.all(limit).map(rowToScheduled),
      boarding: selectBoarding.all(limit).map(rowToBoarding),
      custom: selectCustom.all(limit).map(rowToCustom),
    });
  } catch (err) {
    console.error('GET /api/admin/bookings failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load bookings' });
  }
});

app.post('/api/rent/inquiries', (req, res) => {
  const validationError = validateRentInquiryPost(req.body);
  if (validationError) {
    return res.status(400).json({ ok: false, error: validationError });
  }
  try {
    const nowIso = new Date().toISOString();
    const id = generateRentInquiryId();
    const payload = buildRentInquiryPayload(req.body, id, nowIso);
    const row = rentInquiryDbRowFromPayload(payload, id, nowIso, nowIso);
    const txn = db.transaction(() => {
      insertRentInquiry.run(row);
    });
    txn();
    const saved = getRentInquiryById.get(id);
    res.status(201).json({ ok: true, inquiry: rowToRentInquiry(saved) });
  } catch (err) {
    console.error('POST /api/rent/inquiries failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save rent inquiry' });
  }
});

app.get('/api/rent/inquiries', (req, res) => {
  try {
    let sql = 'SELECT * FROM rent_inquiries WHERE 1=1';
    const params = [];
    if (req.query.status != null && String(req.query.status).trim() !== '') {
      sql += ' AND status = ?';
      params.push(String(req.query.status).trim());
    }
    if (req.query.date != null && String(req.query.date).trim() !== '') {
      sql += ' AND event_date = ?';
      params.push(String(req.query.date).trim());
    }
    if (req.query.city != null && String(req.query.city).trim() !== '') {
      sql += ' AND city = ?';
      params.push(String(req.query.city).trim());
    }
    sql += ' ORDER BY event_date ASC, created_at DESC';
    const rows = db.prepare(sql).all(...params);
    res.json({ ok: true, inquiries: rows.map(rowToRentInquiry) });
  } catch (err) {
    console.error('GET /api/rent/inquiries failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load rent inquiries' });
  }
});

function normalizeRentImportTimestamp(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

app.post('/api/rent/import/preview', (req, res) => {
  const body = req.body || {};
  const inquiries = Array.isArray(body.inquiries) ? body.inquiries : [];
  if (!inquiries.length) {
    return res.status(400).json({ ok: false, error: 'inquiries array is required' });
  }
  try {
    const preview = previewRentImport(inquiries);
    res.json({ ok: true, ...preview });
  } catch (err) {
    console.error('POST /api/rent/import/preview failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to preview rent import' });
  }
});

app.post('/api/rent/import', (req, res) => {
  const body = req.body || {};
  const inquiries = Array.isArray(body.inquiries) ? body.inquiries : [];
  if (!inquiries.length) {
    return res.status(400).json({ ok: false, error: 'inquiries array is required' });
  }
  const mode = body.mode === 'legacy' ? 'legacy' : 'upsert';
  try {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let conflicts = 0;
    const conflictItems = [];
    const errors = [];
    const txn = db.transaction(() => {
      inquiries.forEach((item) => {
        try {
          const outcome = applyRentImportRow(item, mode);
          if (outcome.result === 'imported') imported += 1;
          else if (outcome.result === 'updated') updated += 1;
          else if (outcome.result === 'conflict') {
            conflicts += 1;
            conflictItems.push({
              id: outcome.id,
              backupUpdatedAt: outcome.backupUpdatedAt,
              dbUpdatedAt: outcome.dbUpdatedAt,
              decision: outcome.decision,
            });
          } else if (outcome.result === 'error') {
            skipped += 1;
            errors.push({ id: outcome.id || '', error: outcome.error });
          } else skipped += 1;
        } catch (rowErr) {
          skipped += 1;
          errors.push({
            id: item && item.id != null ? String(item.id) : '',
            error: rowErr.message || 'row failed',
          });
        }
      });
      syncRentIdSequenceFromDb(db);
    });
    txn();
    res.json({
      ok: true,
      mode,
      imported,
      updated,
      skipped,
      conflicts,
      conflictItems,
      errors,
    });
  } catch (err) {
    console.error('POST /api/rent/import failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to import rent inquiries' });
  }
});

app.post('/api/rent/restore/preview', (req, res) => {
  const body = req.body || {};
  const inquiries = Array.isArray(body.inquiries) ? body.inquiries : [];
  if (!inquiries.length) {
    return res.status(400).json({ ok: false, error: 'inquiries array is required' });
  }
  try {
    res.json({
      ok: true,
      backupCount: inquiries.length,
      currentCount: selectAllRentInquiryIds.all().length,
    });
  } catch (err) {
    console.error('POST /api/rent/restore/preview failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to preview rent restore' });
  }
});

app.post('/api/rent/restore', (req, res) => {
  const body = req.body || {};
  const inquiries = Array.isArray(body.inquiries) ? body.inquiries : [];
  if (!inquiries.length) {
    return res.status(400).json({ ok: false, error: 'inquiries array is required' });
  }
  if (body.confirm !== true && body.confirmToken !== 'RESTORE') {
    return res.status(400).json({ ok: false, error: 'confirm required (confirm: true or confirmToken: RESTORE)' });
  }
  try {
    let restored = 0;
    let failed = 0;
    const errors = [];
    const txn = db.transaction(() => {
      deleteAllRentInquiries.run();
      inquiries.forEach((item) => {
        const id = item && item.id != null ? String(item.id).trim() : '';
        if (!id) {
          failed += 1;
          errors.push({ id: '', error: 'missing id' });
          return;
        }
        try {
          const nowIso = new Date().toISOString();
          const createdAt = normalizeRentImportTimestamp(
            item.createdAt || item.letrehozasDatuma || item.created_at,
            nowIso,
          );
          const updatedAt = normalizeRentImportTimestamp(item.updatedAt || item.updated_at, createdAt);
          const payload = buildRentInquiryPayloadFromImport(item, id, createdAt, updatedAt, null);
          const row = rentInquiryDbRowFromPayload(payload, id, createdAt, updatedAt);
          insertRentInquiry.run(row);
          restored += 1;
        } catch (rowErr) {
          failed += 1;
          errors.push({ id, error: rowErr.message || 'insert failed' });
        }
      });
      syncRentIdSequenceFromDb(db);
    });
    txn();
    res.json({ ok: true, restored, failed, errors });
  } catch (err) {
    console.error('POST /api/rent/restore failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to restore rent inquiries' });
  }
});

app.get('/api/rent/inquiries/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  try {
    const row = getRentInquiryById.get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Rent inquiry not found' });
    res.json({ ok: true, inquiry: rowToRentInquiry(row) });
  } catch (err) {
    console.error('GET /api/rent/inquiries/:id failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load rent inquiry' });
  }
});

app.patch('/api/rent/inquiries/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const body = req.body || {};
  try {
    const txn = db.transaction(() => {
      const existing = getRentInquiryById.get(id);
      if (!existing) return { notFound: true };
      const existingPayload = parseRentInquiryPayload(existing);
      const mergedPayload = mergeRentInquiryPatch(existingPayload, id, body);
      const nowIso = new Date().toISOString();
      const row = rentInquiryDbRowFromPayload(
        mergedPayload,
        id,
        existing.created_at,
        nowIso,
      );
      updateRentInquiry.run(row);
      return { row: getRentInquiryById.get(id) };
    });
    const result = txn();
    if (result.notFound) {
      return res.status(404).json({ ok: false, error: 'Rent inquiry not found' });
    }
    res.json({ ok: true, inquiry: rowToRentInquiry(result.row) });
  } catch (err) {
    console.error('PATCH /api/rent/inquiries/:id failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to update rent inquiry' });
  }
});

app.delete('/api/rent/inquiries/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  try {
    const result = deleteRentInquiry.run(id);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Rent inquiry not found' });
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/rent/inquiries/:id failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete rent inquiry' });
  }
});

app.post('/api/reservations', (req, res) => {
  const row = normalizePublicReservation(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'time, stop_name and valid +36 phone required' });
  }
  try {
    insertScheduled.run(row);
    res.status(201).json({ ok: true, reservation: rowToScheduled(row) });
  } catch (err) {
    console.error('POST /api/reservations failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save reservation' });
  }
});

app.post('/api/boarding-requests', (req, res) => {
  const row = normalizePublicBoarding(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'stop_name and valid +36 phone required' });
  }
  try {
    insertBoarding.run(row);
    res.status(201).json({ ok: true, boarding: rowToBoarding({ ...row, status: 'active' }) });
  } catch (err) {
    console.error('POST /api/boarding-requests failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save boarding request' });
  }
});

app.patch('/api/admin/bookings/scheduled/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const existing = getScheduledById.get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'not found' });
  const body = req.body || {};
  const action = body.action != null ? String(body.action).trim() : '';
  try {
    if (action === 'accept') {
      updateScheduledStatus.run({ id, status: 'accepted' });
    } else if (action === 'delete') {
      updateScheduledStatus.run({ id, status: 'cancelled' });
    } else if (action === 'modify') {
      updateScheduledFields.run({
        id,
        time: body.time != null ? String(body.time).trim() : existing.time,
        stop_name: body.stop_name != null ? String(body.stop_name).trim() : existing.stop_name,
        passenger_count: Math.max(1, parseInt(body.passenger_count != null ? body.passenger_count : existing.passenger_count, 10) || 1),
        phone: body.phone != null ? (normalizeHuPhone(body.phone) || existing.phone) : existing.phone,
        status: 'modified',
        note: body.note != null ? String(body.note).trim() : (existing.note || ''),
      });
    } else if (body.status && RESERVATION_STATUSES.has(String(body.status))) {
      updateScheduledStatus.run({ id, status: String(body.status) });
    } else {
      return res.status(400).json({ ok: false, error: 'action must be accept, modify, or delete' });
    }
    const updated = getScheduledById.get(id);
    res.json({ ok: true, reservation: rowToScheduled(updated) });
  } catch (err) {
    console.error('PATCH scheduled booking failed:', err);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

app.patch('/api/admin/bookings/boarding/:id/dismiss', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  try {
    const result = dismissBoarding.run({ id });
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('PATCH boarding dismiss failed:', err);
    res.status(500).json({ ok: false, error: 'Dismiss failed' });
  }
});

app.get('/api/reports/daily', (req, res) => {
  const date = parseReportDate(req.query.date);
  const vehicleId = req.query.vehicle_id != null ? String(req.query.vehicle_id).trim() : '';
  try {
    const rows = buildDailyVehicleReport(date, vehicleId || null);
    const totals = rows.reduce((acc, r) => {
      acc.passengers += r.passengers;
      acc.revenue_huf += r.revenue_huf;
      return acc;
    }, { passengers: 0, revenue_huf: 0 });
    res.json({
      ok: true,
      date,
      vehicle_id: vehicleId || null,
      capacity_default: REPORT_DEFAULT_CAPACITY,
      ticket_price_huf: REPORT_TICKET_PRICE_HUF,
      rows,
      totals,
    });
  } catch (err) {
    console.error('GET /api/reports/daily failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to build report' });
  }
});

app.get('/api/reports/daily.csv', (req, res) => {
  const date = parseReportDate(req.query.date);
  const vehicleId = req.query.vehicle_id != null ? String(req.query.vehicle_id).trim() : '';
  try {
    const rows = buildDailyVehicleReport(date, vehicleId || null);
    const header = ['datum', 'jarmu_id', 'jarmu_nev', 'utasszam', 'kapacitas', 'szabad_hely', 'kihasznaltsag_pct', 'bevetel_huf'];
    const lines = [header.join(';')];
    rows.forEach((r) => {
      lines.push([
        r.date,
        r.vehicle_id,
        r.vehicle_name,
        r.passengers,
        r.capacity,
        r.free_seats,
        r.utilization_pct,
        r.revenue_huf,
      ].join(';'));
    });
    const csv = '\uFEFF' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="napi_report_${date}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('GET /api/reports/daily.csv failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to export CSV' });
  }
});

app.post('/api/trip-archives', (req, res) => {
  try {
    const saved = saveTripArchive(req.body || {});
    res.status(201).json({ ok: true, filename: saved.filename });
  } catch (err) {
    console.error('POST /api/trip-archives failed:', err);
    res.status(400).json({ ok: false, error: err.message || 'Failed to save archive' });
  }
});

app.post('/api/upload-route', (req, res) => {
  try {
    const saved = saveRouteUpload(req.body || {});
    res.status(201).json({ ok: true, id: saved.id, gps_point_count: saved.gps_point_count });
  } catch (err) {
    console.error('POST /api/upload-route failed:', err);
    res.status(400).json({ ok: false, error: err.message || 'Failed to upload route' });
  }
});

app.get('/api/admin/route-uploads', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, timestamp, vehicle_id, driver_id, driver_name, route, gps_point_count, created_at
      FROM route_uploads
      ORDER BY timestamp DESC
      LIMIT 500
    `).all();
    res.json({ ok: true, count: rows.length, uploads: rows });
  } catch (err) {
    console.error('GET /api/admin/route-uploads failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to list uploads' });
  }
});

app.get('/api/admin/route-uploads/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  try {
    const row = db.prepare('SELECT * FROM route_uploads WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not found' });
    res.type('application/geo+json');
    res.send(row.geojson_json);
  } catch (err) {
    console.error('GET route-upload failed:', err);
    res.status(500).json({ ok: false, error: 'read failed' });
  }
});

app.get('/api/admin/trip-archives', (_req, res) => {
  try {
    const archives = listTripArchiveFiles();
    res.json({ ok: true, count: archives.length, archives });
  } catch (err) {
    console.error('GET /api/admin/trip-archives failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to list archives' });
  }
});

app.get('/api/admin/trip-archives/:filename', (req, res) => {
  const filename = safeArchiveFilename(req.params.filename);
  if (!filename) return res.status(400).json({ ok: false, error: 'Invalid filename' });
  const full = path.join(tripArchivesDir, filename);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'not found' });
  res.type('application/geo+json');
  return res.sendFile(full, (err) => {
    if (err) res.status(500).json({ ok: false, error: 'read failed' });
  });
});

app.post('/api/shift-reports', (req, res) => {
  const body = req.body || {};
  const shiftId = String(body.shift_id || body.shift || '').trim();
  const dateStr = parseReportDate(body.date);
  if (!shiftId) return res.status(400).json({ ok: false, error: 'shift_id required' });
  try {
    const saved = saveDailyShiftCsv(shiftId, dateStr);
    res.status(201).json({ ok: true, filename: saved.filename, date: dateStr });
  } catch (err) {
    console.error('POST /api/shift-reports failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to generate CSV' });
  }
});

app.get('/api/admin/daily-reports', (_req, res) => {
  try {
    ensureDataDir(dailyReportsDir);
    const reports = (fs.existsSync(dailyReportsDir) ? fs.readdirSync(dailyReportsDir) : [])
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((filename) => {
        const full = path.join(dailyReportsDir, filename);
        const stat = fs.statSync(full);
        return { filename, size_bytes: stat.size, saved_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
    res.json({ ok: true, count: reports.length, reports });
  } catch (err) {
    console.error('GET /api/admin/daily-reports failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to list reports' });
  }
});

app.get('/api/admin/daily-reports/:filename', (req, res) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || !filename.toLowerCase().endsWith('.csv')) {
    return res.status(400).json({ ok: false, error: 'Invalid filename' });
  }
  const full = path.join(dailyReportsDir, filename);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'not found' });
  res.type('text/csv; charset=utf-8');
  return res.sendFile(full, (err) => {
    if (err) res.status(500).json({ ok: false, error: 'read failed' });
  });
});

app.get('/api/service-records', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  try {
    res.json({
      ok: true,
      records: selectServiceRecords.all(limit).map(rowToServiceRecord),
    });
  } catch (err) {
    console.error('GET /api/service-records failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load service records' });
  }
});

app.post('/api/service-records', (req, res) => {
  const row = normalizeServiceRecordInput(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'vehicle_id, service_type required' });
  }
  try {
    insertServiceRecord.run(row);
    res.status(201).json({ ok: true, record: rowToServiceRecord(row) });
  } catch (err) {
    console.error('POST /api/service-records failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save service record' });
  }
});

app.get('/api/driver-notes', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  try {
    res.json({
      ok: true,
      notes: selectDriverNotes.all(limit).map(rowToDriverNote),
    });
  } catch (err) {
    console.error('GET /api/driver-notes failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load driver notes' });
  }
});

app.post('/api/driver-notes', (req, res) => {
  const row = normalizeDriverNoteInput(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'vehicle_id, category, note required' });
  }
  try {
    insertDriverNote.run(row);
    const saved = selectDriverNoteById.get(row.id);
    res.status(201).json({ ok: true, note: rowToDriverNote(saved || row) });
  } catch (err) {
    console.error('POST /api/driver-notes failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save driver note' });
  }
});

app.get('/routes/:filename', (req, res, next) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename !== req.params.filename) {
    return res.status(400).json({ ok: false, error: 'Invalid filename' });
  }
  const filePath = path.join(routesDir, filename);
  if (!fs.existsSync(filePath)) {
    return next();
  }
  if (filename.toLowerCase().endsWith('.geojson')) {
    res.type('application/geo+json');
  }
  return res.sendFile(filePath, (err) => {
    if (err) next(err);
  });
});

app.use(
  '/routes',
  express.static(routesDir, {
    index: false,
    dotfiles: 'deny',
    fallthrough: true,
  })
);

const frontendDir = path.join(__dirname, '..', 'frontend');
const rentDir = path.join(frontendDir, 'rent');

app.get(['/admin', '/admin/', '/admin.html'], (_req, res) => {
  res.sendFile(path.join(frontendDir, 'admin', 'index.html'));
});

app.get(['/rent/public', '/rent/public/'], (_req, res) => {
  res.sendFile(path.join(rentDir, 'public.html'));
});
app.get(['/rent/admin', '/rent/admin/'], (_req, res) => {
  res.sendFile(path.join(rentDir, 'admin.html'));
});
app.use('/rent', express.static(rentDir, { index: false, fallthrough: true }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});
app.get(['/index', '/index/'], (_req, res) => {
  res.redirect(301, '/');
});
app.get('/index.html', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});
app.use('/assets', express.static(path.join(frontendDir, 'assets')));
app.use('/driver', express.static(path.join(frontendDir, 'driver'), { index: 'index.html' }));
app.use('/public', express.static(path.join(frontendDir, 'public'), { index: 'index.html' }));
app.get('/opnav-config.js', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'opnav-config.js'));
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Operativ Navigator API listening on port ${PORT}`);
  console.log(`Database: ${DATABASE_PATH}`);
  console.log(`Frontend: http://localhost:${PORT}/  http://localhost:${PORT}/public/  http://localhost:${PORT}/driver/  http://localhost:${PORT}/admin  http://localhost:${PORT}/rent/public  http://localhost:${PORT}/rent/admin`);
  logRoutesStartup();
});
